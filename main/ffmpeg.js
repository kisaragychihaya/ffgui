const { app, ipcMain, dialog } = require('electron');
const { spawn, execFile, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ffmpeg 可执行文件路径：
// - Windows：内置 bin/ffmpeg.exe（开发时读项目根 bin/，打包后经 extraResource 在 resources/bin/）
// - macOS：使用 Homebrew 安装的 ffmpeg（brew install ffmpeg）
// - Linux：使用系统 PATH 中的 ffmpeg
function getFfmpegPath() {
  if (process.platform === 'win32') {
    const base = app.isPackaged ? process.resourcesPath : app.getAppPath();
    return path.join(base, 'bin', 'ffmpeg.exe');
  }
  if (process.platform === 'darwin') {
    // 优先使用内置的预编译 ffmpeg（bin/bin/ffmpeg）。自建 static 构建是
    // 混合静态链接：大部分库静态编入，无 .a 的库仍动态链接、经 dylibbundler
    // 收集到 bin/lib/，引用 @executable_path/../lib，相对布局不能变。
    // 打包后位于 resources/bin/ 下
    const base = app.isPackaged ? process.resourcesPath : app.getAppPath();
    const bundled = path.join(base, 'bin', 'bin', 'ffmpeg');
    if (fs.existsSync(bundled)) return bundled;
    // 未内置时回退到 Homebrew：Apple Silicon 为 /opt/homebrew，Intel 为 /usr/local
    const candidates = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'];
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
    // 兜底：从 PATH 查找（从终端启动时 Homebrew 可能在 PATH 中）
    try {
      const found = execFileSync('/usr/bin/which', ['ffmpeg'], { encoding: 'utf8' }).trim();
      if (found) return found;
    } catch {
      // 未找到，返回 null 由上层给出安装提示
    }
    return null;
  }
  return 'ffmpeg';
}

function getCachePath() {
  return path.join(app.getPath('userData'), 'ffmpeg-caps.json');
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile(getFfmpegPath(), args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      // ffmpeg 部分查询输出走 stderr，这里把两者都返回
      if (err && !stdout && !stderr) return reject(err);
      resolve({ stdout, stderr });
    });
  });
}

// ---------- 能力解析 ----------

function parseHwaccels(output) {
  const lines = output.split(/\r?\n/);
  const result = [];
  let started = false;
  for (const line of lines) {
    const t = line.trim();
    if (!started) {
      if (/hardware acceleration methods/i.test(t)) started = true;
      continue;
    }
    if (t) result.push(t);
  }
  return result;
}

function parseEncoders(output) {
  const video = [];
  const audio = [];
  let started = false;
  for (const line of output.split(/\r?\n/)) {
    if (!started) {
      if (/^\s*-{2,}\s*$/.test(line)) started = true;
      continue;
    }
    const m = line.match(/^\s*([VAS])[A-Z.]{5}\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const entry = { name: m[2], description: m[3].trim() };
    if (m[1] === 'V') video.push(entry);
    else if (m[1] === 'A') audio.push(entry);
  }
  return { video, audio };
}

function parseMuxers(output) {
  const muxers = [];
  let started = false;
  for (const line of output.split(/\r?\n/)) {
    if (!started) {
      if (/^\s*-{2,}\s*$/.test(line)) started = true;
      continue;
    }
    // 例如：" DE matroska,webm    Matroska / WebM"
    const m = line.match(/^\s*([D ])([E ])\s+(\S+)\s*(.*)$/);
    if (!m || m[2] !== 'E') continue;
    const desc = (m[4] || '').trim();
    for (const name of m[3].split(',')) {
      muxers.push({ name: name.trim(), description: desc });
    }
  }
  return muxers;
}

// ---------- 硬件编码器实测 ----------

// 硬件相关编码器的命名后缀（nvenc/qsv/amf/mf/vaapi/vulkan/d3dxx/videotoolbox 等）
const HW_ENCODER_PATTERN = /_(nvenc|qsv|amf|mf|vaapi|vulkan|d3d11va|d3d12va|videotoolbox)$/;

// -encoders 列表只说明构建时编译了该编码器，不代表当前硬件/驱动能跑。
// 对每个硬件编码器试编码 1 帧到 null 设备，实测是否可用。
// 注意测试分辨率用 256x256：部分编码器（如 nvenc）有最小分辨率限制，
// 过小的测试帧会造成"假不可用"
function testEncoder(name) {
  return new Promise((resolve) => {
    execFile(getFfmpegPath(), [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=size=256x256:duration=0.1:rate=1',
      '-frames:v', '1', '-c:v', name, '-f', 'null', '-',
    ], { timeout: 15000 }, (err) => resolve(!err));
  });
}

async function detectCapabilities() {
  const ffmpeg = getFfmpegPath();
  if (!ffmpeg) {
    throw new Error('未找到 ffmpeg，请先通过 Homebrew 安装：brew install ffmpeg');
  }
  // 带路径分隔符的才做存在性检查（裸命令名靠 PATH 解析）
  if (ffmpeg.includes(path.sep) && !fs.existsSync(ffmpeg)) {
    throw new Error(`未找到 ffmpeg：${ffmpeg}`);
  }

  const [versionRes, hwRes, encRes, fmtRes] = await Promise.all([
    runFfmpeg(['-version']),
    runFfmpeg(['-hide_banner', '-hwaccels']),
    runFfmpeg(['-hide_banner', '-encoders']),
    runFfmpeg(['-hide_banner', '-formats']),
  ]);

  const encoders = parseEncoders(encRes.stdout);

  // 实测硬件编码器（并行试编码，仅在首次探测时执行一次）
  const hwNames = encoders.video.map((e) => e.name).filter((n) => HW_ENCODER_PATTERN.test(n));
  console.log(`[ffgui] 首次探测：正在试编码检测 ${hwNames.length} 个硬件编码器…`);
  const t0 = Date.now();
  const results = await Promise.all(hwNames.map(async (name) => [name, await testEncoder(name)]));
  const broken = results.filter(([, ok]) => !ok).map(([name]) => name);
  for (const e of encoders.video) {
    if (broken.includes(e.name)) e.broken = true;
  }
  console.log(`[ffgui] 硬件编码器检测完成，耗时 ${Date.now() - t0}ms，`
    + `可用 ${hwNames.length - broken.length}/${hwNames.length}`
    + (broken.length ? `，不可用：${broken.join(', ')}` : ''));

  const versionLine = (versionRes.stdout || '').split(/\r?\n/)[0] || '';
  const caps = {
    ffmpegPath: ffmpeg,
    version: versionLine.replace(/^ffmpeg version\s*/i, '').trim(),
    hwaccels: parseHwaccels(hwRes.stdout + '\n' + hwRes.stderr),
    encoders,
    muxers: parseMuxers(fmtRes.stdout),
    createdAt: new Date().toISOString(),
  };
  return caps;
}

// 缓存结构版本：解析逻辑变化时递增，使旧缓存自动失效
const CACHE_VERSION = 4;

// 首次启动生成缓存；之后版本一致则直接读缓存
async function getCapabilities() {
  const cachePath = getCachePath();
  let cached = null;
  try {
    cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  } catch {
    // 无缓存或缓存损坏，重新探测
  }

  if (cached && cached.version && cached.cacheVersion === CACHE_VERSION) {
    // 校验 ffmpeg 版本是否变化，变化则重新探测
    const versionRes = await runFfmpeg(['-version']);
    const current = ((versionRes.stdout || '').split(/\r?\n/)[0] || '')
      .replace(/^ffmpeg version\s*/i, '').trim();
    if (current && current === cached.version) {
      return cached;
    }
  }

  const caps = await detectCapabilities();
  caps.cacheVersion = CACHE_VERSION;
  fs.writeFileSync(cachePath, JSON.stringify(caps, null, 2), 'utf8');
  return caps;
}

// ---------- 转换任务 ----------

// 仅音频的封装格式
const AUDIO_ONLY_FORMATS = new Set(['mp3', 'm4a', 'flac', 'wav', 'ogg', 'opus']);
// 无音频轨的封装格式
const VIDEO_ONLY_FORMATS = new Set(['gif']);
// 这些输出格式采用单音轨模式；多音轨输入必须由用户明确选轨。
const SINGLE_AUDIO_FORMATS = new Set(['mp3', 'flac', 'wav', 'flv']);
// 支持 -crf 质量参数的编码器
const CRF_ENCODERS = new Set(['libx264', 'libx265', 'libvpx-vp9', 'libaom-av1', 'libsvtav1']);
const CRF_MAP = { high: 18, medium: 23, low: 28 };
// VideoToolbox 不支持 -crf；Apple Silicon 上可用 -q:v（1-100，数值越大质量越高）
// Intel Mac 上传 -q:v 会直接报错（ffmpeg 源码 videotoolboxenc.c 限定 TARGET_CPU_ARM64），
// 因此仅在 darwin + arm64 下使用；其余平台码率留空时完全交给编码器默认值。
// 仅 h264/hevc 映射 -q:v：ProRes 的画质由 -profile:v 档位决定，且 ffmpeg 源码中
// ProRes 明确不走码率/质量属性分支，传 -q:v 行为未验证，故排除
const VT_QSCALE_MAP = { high: 80, medium: 65, low: 50 };
const VT_ENCODER_PATTERN = /^(h264|hevc)_videotoolbox$/;
// nvenc/qsv/amf 的恒定画质参数（码率留空时按质量档传入，数值越小质量越高，语义同 QP/CRF）
// nvenc 用 VBR + -cq；qsv 用 -global_quality（ICQ 模式）；amf 用 QVBR + -qvbr_quality_level
const HW_QUALITY_ARGS = {
  nvenc: (q) => ['-rc', 'vbr', '-cq', String(q)],
  qsv: (q) => ['-global_quality', String(q)],
  amf: (q) => ['-rc', 'qvbr', '-qvbr_quality_level', String(q)],
};
const HW_QUALITY_PATTERN = /_(nvenc|qsv|amf)$/;

let currentChild = null;
let cancelled = false;

function pathKey(file) {
  const resolved = path.resolve(file);
  return process.platform === 'linux' ? resolved : resolved.toLowerCase();
}

// 同时避开现有文件、全部源文件和本批已分配的输出；执行时再用 -n 防止覆盖。
function uniqueOutputPath(candidate, reserved = new Set()) {
  const ext = path.extname(candidate);
  const stem = candidate.slice(0, candidate.length - ext.length);
  let out = candidate;
  let suffix = 2;
  while (fs.existsSync(out) || reserved.has(pathKey(out))) {
    out = `${stem}_${suffix++}${ext}`;
  }
  reserved.add(pathKey(out));
  return out;
}

function buildOutputPath(input, outputDir, format, reserved = new Set()) {
  const dir = outputDir || path.dirname(input);
  const base = path.basename(input, path.extname(input));
  let out = path.join(dir, `${base}.${format}`);
  if (pathKey(out) === pathKey(input)) {
    out = path.join(dir, `${base}_ffgui.${format}`);
  }
  reserved.add(pathKey(input));
  return uniqueOutputPath(out, reserved);
}

function selectedAudioTrack(job) {
  if (job.audioTrack == null || job.audioTrack === '') return null;
  const track = Number(job.audioTrack);
  if (!Number.isSafeInteger(track) || track < 1) throw new Error('音轨序号必须是从 1 开始的整数');
  return track - 1;
}

function validateAudioSelection(job, probes, merging = false) {
  if (VIDEO_ONLY_FORMATS.has(job.format) || job.acodec === 'none') return;
  const track = selectedAudioTrack(job);
  const count = (p) => p.audioTracks.length;
  if (track === null && SINGLE_AUDIO_FORMATS.has(job.format) && probes.some((p) => count(p) > 1)) {
    throw new Error(`${job.format.toUpperCase()} 使用单音轨输出，请填写要保留的音轨序号，或改用 MKV/M4A 等多音轨格式`);
  }
  if (track !== null && (merging ? !probes.some((p) => count(p) > track) : probes.some((p) => count(p) <= track))) {
    throw new Error(`输入文件没有第 ${track + 1} 条音轨`);
  }
}

// 预设在主进程再次落实，不能只依赖界面填值；必须在生成输出扩展名前调用。
function normalizeConvertJob(job) {
  if (!job.devicePreset) return { ...job };
  const sizes = { 'ipod4-540': { w: 960, h: 540 }, 'ipod4-720': { w: 1280, h: 720 } };
  if (!sizes[job.devicePreset]) throw new Error('未知的设备预设');
  return { ...job, format: 'mp4', vcodec: 'libx264', acodec: 'aac', hwaccel: '',
    pixFmt: 'yuv420p', h264Profile: 'main', h264Level: '3.1', fps: '', maxFps: 30,
    scale: sizes[job.devicePreset], fitScale: true, vbitrate: 2000, vrateMode: 'vbr',
    maxrate: 3000, bufsize: 6000, abitrate: 128, channels: 2, sampleRate: 48000 };
}

function validateConvertOptions(job) {
  const video = !AUDIO_ONLY_FORMATS.has(job.format) && job.vcodec !== 'none';
  const audio = !VIDEO_ONLY_FORMATS.has(job.format) && job.acodec !== 'none';
  if (video) {
    if (job.vcodec === 'copy' && (job.pixFmt || job.h264Profile || job.h264Level || job.fps || job.scale || job.hdr2sdr)) {
      throw new Error('直接复制视频不能改变位深、Profile、Level、帧率、分辨率或动态范围，请选择编码器');
    }
    if (job.pixFmt && !['yuv420p', 'yuv420p10le'].includes(job.pixFmt)) throw new Error('不支持的像素格式');
    if (job.h264Profile || job.h264Level) {
      if (job.vcodec !== 'libx264') throw new Error('当前 Profile/Level 选项仅用于 H.264 (libx264)');
      if (job.h264Profile && !['baseline', 'main', 'high', 'high10'].includes(job.h264Profile)) throw new Error('不支持的 H.264 Profile');
      if (job.h264Level && !['3.0', '3.1', '4.0', '4.1', '4.2', '5.0', '5.1', '5.2'].includes(job.h264Level)) throw new Error('不支持的 H.264 Level');
      if (job.pixFmt === 'yuv420p10le' && ['baseline', 'main', 'high'].includes(job.h264Profile)) {
        throw new Error('所选 H.264 Profile 不支持 10-bit，请选择 8-bit 或 High 10');
      }
    }
    if (job.fps && !['23.976', '24', '25', '29.97', '30', '50', '59.94', '60'].includes(String(job.fps))) throw new Error('不支持的帧率');
  }
  if (audio) {
    if (job.acodec === 'copy' && (job.channels || job.sampleRate)) throw new Error('直接复制音频不能改变声道或采样率');
    if (job.channels && ![1, 2, 6].includes(Number(job.channels))) throw new Error('不支持的声道数');
    if (job.sampleRate && ![22050, 32000, 44100, 48000, 96000].includes(Number(job.sampleRate))) throw new Error('不支持的采样率');
  }
  if (job.format === 'mp3' && job.id3Version && !['3', '4'].includes(String(job.id3Version))) throw new Error('ID3 版本必须为 2.3 或 2.4');
}

function buildArgs(job, input, outPath, probe = {}) {
  job = normalizeConvertJob(job);
  validateConvertOptions(job);
  const args = ['-hide_banner', '-n'];
  if (job.hwaccel) {
    args.push('-hwaccel', job.hwaccel);
  }
  args.push('-i', input);

  const audioOnly = AUDIO_ONLY_FORMATS.has(job.format);
  const videoOnly = VIDEO_ONLY_FORMATS.has(job.format);
  // 只映射探测到的 attached pic，绝不能把音乐视频当作封面。
  // MP3/M4A/FLAC 接受 JPEG/PNG 封面；其他图片编码转换为 JPEG。
  const covers = audioOnly && job.preserveCover !== false && ['mp3', 'm4a', 'flac'].includes(job.format)
    ? (probe.covers || []) : [];
  // 显式映射：默认保留全部音轨；序号按每个输入文件的音轨顺序从 1 开始。
  if (!audioOnly && job.vcodec !== 'none') args.push('-map', '0:V:0?');
  if (!videoOnly && job.acodec !== 'none') {
    const track = selectedAudioTrack(job);
    args.push('-map', track === null ? (job.devicePreset ? '0:a:0?' : '0:a?') : `0:a:${track}`);
  }
  for (const cover of covers) args.push('-map', `0:${cover.index}`);
  args.push('-map_metadata', job.preserveMetadata === false ? '-1' : '0');
  if (job.preserveMetadata === false) args.push('-map_metadata:s:a', '-1');
  if (job.format === 'mp3') args.push('-id3v2_version', String(job.id3Version || 3));
  // MKV 同时保留字幕及字体附件；其他容器不盲目复制可能不兼容的附加流。
  if (!audioOnly && !videoOnly && job.vcodec !== 'none') {
    if (job.format === 'mkv') args.push('-map', '0:s?', '-map', '0:t?', '-c:s', 'copy', '-c:t', 'copy');
  }
  // 高级参数：码率（kbps），0/缺省表示不传入，由 ffmpeg 用默认值
  const vbitrate = Math.floor(Number(job.vbitrate)) || 0;
  const abitrate = Math.floor(Number(job.abitrate)) || 0;
  // 高级参数：分辨率，{w,h} 或 {percent}；null 表示不缩放（默认 100%）
  const scale = job.scale || null;

  // 视频
  if (audioOnly || job.vcodec === 'none') {
    if (covers.length) {
      covers.forEach((cover, i) => {
        args.push(`-c:v:${i}`, ['png', 'mjpeg'].includes(cover.codec) ? 'copy' : 'mjpeg',
          `-disposition:v:${i}`, 'attached_pic');
      });
    } else args.push('-vn');
  } else if (job.vcodec && job.vcodec !== 'auto') {
    if (job.vcodec === 'copy') {
      args.push('-c:v', 'copy');
    } else {
      args.push('-c:v', job.vcodec);
      if (vbitrate > 0) {
        // 指定码率时优先于 CRF 质量档
        args.push('-b:v', `${vbitrate}k`);
        if (job.vrateMode === 'cbr') {
          args.push('-minrate', `${vbitrate}k`, '-maxrate', `${vbitrate}k`,
            '-bufsize', `${vbitrate * 2}k`);
        }
        // vbr：仅 -b:v，由编码器自行做可变码率
      } else if (CRF_ENCODERS.has(job.vcodec)) {
        args.push('-crf', String(CRF_MAP[job.quality] ?? CRF_MAP.medium));
      } else if (VT_ENCODER_PATTERN.test(job.vcodec) &&
                 process.platform === 'darwin' && process.arch === 'arm64') {
        args.push('-q:v', String(VT_QSCALE_MAP[job.quality] ?? VT_QSCALE_MAP.medium));
      } else {
        const hwMatch = job.vcodec.match(HW_QUALITY_PATTERN);
        if (hwMatch) {
          args.push(...HW_QUALITY_ARGS[hwMatch[1]](CRF_MAP[job.quality] ?? CRF_MAP.medium));
        }
      }
    }
  } else if (vbitrate > 0) {
    // vcodec 为 auto 时同样可指定码率（作用于容器默认编码器）
    args.push('-b:v', `${vbitrate}k`);
    if (job.vrateMode === 'cbr') {
      args.push('-minrate', `${vbitrate}k`, '-maxrate', `${vbitrate}k`,
        '-bufsize', `${vbitrate * 2}k`);
    }
  }

  // 音频
  if (VIDEO_ONLY_FORMATS.has(job.format) || job.acodec === 'none') {
    args.push('-an');
  } else if (job.acodec && job.acodec !== 'auto') {
    if (job.acodec === 'copy') {
      args.push('-c:a', 'copy');
    } else {
      args.push('-c:a', job.acodec);
      if (abitrate > 0) args.push('-b:a', `${abitrate}k`);
    }
  } else if (abitrate > 0) {
    // acodec 为 auto 时同样可指定音频码率
    args.push('-b:a', `${abitrate}k`);
  }
  if (!videoOnly && job.acodec !== 'none' && job.acodec !== 'copy') {
    if (job.channels) args.push('-ac', String(job.channels));
    if (job.sampleRate) args.push('-ar', String(job.sampleRate));
    if (job.devicePreset) args.push('-profile:a', 'aac_low');
  }

  // 视频滤镜链：仅在重编码视频时生效（copy/无视频/纯音频格式下跳过）
  // - HDR→SDR 勾选时加入色调映射链（zscale 线性光 → tonemap → bt709），未勾选完全不传
  // - 分辨率缩放（scale）追加在链尾
  const canFilter = !audioOnly && job.vcodec !== 'copy' && job.vcodec !== 'none';
  if (canFilter) {
    // Main/Baseline/High 默认用 8-bit，避免继承源文件的 10-bit 导致编码失败。
    const pixFmt = job.pixFmt || (['baseline', 'main', 'high'].includes(job.h264Profile) ? 'yuv420p' : '');
    if (pixFmt) args.push('-pix_fmt', pixFmt);
    if (job.h264Profile) args.push('-profile:v', job.h264Profile);
    if (job.h264Level) args.push('-level:v', job.h264Level);
    const rates = { '23.976': '24000/1001', '29.97': '30000/1001', '59.94': '60000/1001' };
    if (job.fps) args.push('-r', rates[job.fps] || String(job.fps), '-fps_mode', 'cfr');
    else if (job.maxFps) args.push('-fpsmax', String(job.maxFps));
    if (job.maxrate) args.push('-maxrate', `${job.maxrate}k`, '-bufsize', `${job.bufsize}k`);
  }
  const vf = [];
  if (canFilter && job.hdr2sdr) {
    vf.push(
      'zscale=transfer=linear:npl=100',
      'format=gbrpf32le',
      'zscale=primaries=bt709',
      'tonemap=hable',
      'zscale=transfer=bt709:matrix=bt709:range=full',
      'format=yuv420p',
    );
  }
  if (canFilter && scale) {
    const w = Math.floor(Number(scale.w)) || 0;
    const h = Math.floor(Number(scale.h)) || 0;
    const percent = Number(scale.percent) || 0;
    if (w > 0 && h > 0) {
      vf.push(job.fitScale
        ? `scale=${w}:${h}:force_original_aspect_ratio=decrease:force_divisible_by=2:reset_sar=1`
        : `scale=${w}:${h}`);
    } else if (percent > 0 && percent !== 100) {
      // 百分比缩放；取偶数尺寸避免 yuv420p 编码器报错
      vf.push(`scale=trunc(iw*${percent}/200)*2:trunc(ih*${percent}/200)*2`);
    }
  }
  if (vf.length > 0) {
    args.push('-vf', vf.join(','));
  }
  if (job.devicePreset) args.push('-movflags', '+faststart');
  if (job.sampleOnly) args.push('-t', '30');

  args.push('-nostats', '-progress', 'pipe:1', outPath);
  return args;
}

function parseDuration(text) {
  const m = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!m) return 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

function parseTimeToSeconds(t) {
  const m = t.match(/(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!m) return 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

// 通用 ffmpeg 任务执行器：spawn、stderr 日志转发、-progress 解析、结束处理
// taskName 用于控制台日志措辞（转换/合并）
function runFfmpegTask({ args, index, label, output, getDuration, onStderrText, send, taskName }) {
  return new Promise((resolve) => {
    const child = spawn(getFfmpegPath(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
    currentChild = child;

    let stderrTail = '';
    let errLineBuf = '';
    let outBuffer = '';
    let kv = {};
    let progressEnded = false;

    send({ type: 'file-start', index, input: label, output });
    console.log(`[ffgui] 开始${taskName} (${index + 1}): ${label}`);
    console.log(`[ffgui] 命令: ffmpeg ${args.join(' ')}`);

    // ffmpeg 的日志走 stderr，按行转发到主进程控制台
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderrTail = (stderrTail + text).slice(-4000);
      if (onStderrText) onStderrText(stderrTail);

      errLineBuf += text;
      const lines = errLineBuf.split(/\r\n|\r|\n/);
      errLineBuf = lines.pop() || '';
      for (const line of lines) {
        if (line.trim()) console.log(`[ffmpeg] ${line}`);
      }
    });

    // -progress 输出为连续的 key=value 行，每个统计块以 "progress=continue|end" 行结尾
    child.stdout.on('data', (chunk) => {
      outBuffer += chunk.toString();
      let nl;
      while ((nl = outBuffer.indexOf('\n')) >= 0) {
        const line = outBuffer.slice(0, nl).trim();
        outBuffer = outBuffer.slice(nl + 1);
        if (!line) continue;
        const eq = line.indexOf('=');
        if (eq <= 0) continue;
        const key = line.slice(0, eq);
        const val = line.slice(eq + 1);
        if (key !== 'progress') {
          kv[key] = val;
          continue;
        }
        // 一个统计块结束
        if (val === 'end') progressEnded = true;
        const duration = getDuration();
        const timeSec = kv.out_time ? parseTimeToSeconds(kv.out_time) : 0;
        const percent = duration > 0 ? Math.min(99, Math.round((timeSec / duration) * 100)) : 0;
        send({
          type: 'progress',
          index,
          input: label,
          percent,
          time: timeSec,
          duration,
          speed: kv.speed || '',
          done: val === 'end',
        });
        kv = {};
      }
    });

    child.on('error', (err) => {
      currentChild = null;
      send({ type: 'file-error', index, input: label, error: String(err) });
      resolve({ ok: false });
    });

    child.on('close', (code) => {
      currentChild = null;
      // 冲刷末尾未换行的日志
      if (errLineBuf.trim()) console.log(`[ffmpeg] ${errLineBuf.trim()}`);
      if (cancelled) {
        console.log(`[ffgui] 已取消 (${index + 1}): ${label}`);
        send({ type: 'file-error', index, input: label, error: '已取消' });
        return resolve({ ok: false, cancelled: true });
      }
      // 部分 FFmpeg 构建在 -n 拒绝覆盖时仍返回 0，必须同时收到完成统计块。
      if (code === 0 && progressEnded) {
        console.log(`[ffgui] ${taskName}完成 (${index + 1}): ${output}`);
        send({ type: 'file-done', index, input: label, output });
        resolve({ ok: true });
      } else {
        console.log(`[ffgui] ${taskName}失败 (${index + 1})，退出码 ${code}: ${label}`);
        const tail = stderrTail.split(/\r?\n/).filter(Boolean).slice(-5).join('\n');
        const reason = code === 0 ? 'ffmpeg 未完成输出' : `ffmpeg 退出码 ${code}`;
        send({ type: 'file-error', index, input: label, error: `${reason}\n${tail}` });
        resolve({ ok: false });
      }
    });
  });
}

async function convertOne(job, input, index, send, outPath) {
  let args;
  try {
    const probe = await probeFile(input);
    validateAudioSelection(job, [probe]);
    args = buildArgs(job, input, outPath, probe);
    if (probe.covers.length && job.preserveCover !== false && AUDIO_ONLY_FORMATS.has(job.format)
        && !['mp3', 'm4a', 'flac'].includes(job.format)) {
      send({ type: 'file-warning', index, input, warning: '此输出格式尚未实现封面保留；需要封面时请选择 MP3、M4A 或 FLAC' });
    }
    if (cancelled) return { ok: false, cancelled: true };
  } catch (err) {
    send({ type: 'file-error', index, input, error: err.message });
    return { ok: false };
  }
  // 时长从 stderr 的 Duration 行惰性解析
  let duration = 0;
  return runFfmpegTask({
    args,
    index,
    label: input,
    output: outPath,
    getDuration: () => duration,
    onStderrText: (tail) => { if (!duration) duration = parseDuration(tail); },
    send,
    taskName: '转换',
  });
}

async function runJob(sender, job) {
  job = normalizeConvertJob(job);
  cancelled = false;
  const reserved = new Set(job.inputs.map(pathKey));
  const outputs = job.inputs.map((input) => buildOutputPath(input, job.outputDir, job.format, reserved));
  const results = [];
  for (let i = 0; i < job.inputs.length; i++) {
    if (cancelled) break;
    results.push(await convertOne(job, job.inputs[i], i, (evt) => {
      if (!sender.isDestroyed()) sender.send('ffgui:convert-event', evt);
    }, outputs[i]));
  }
  const done = results.filter((r) => r && r.ok).length;
  return { total: job.inputs.length, done, cancelled };
}

// ---------- 媒体探测 / 音视频合并 ----------

// 用 ffmpeg -i 的 stderr 探测媒体信息（时长、有无音视频流、分辨率）
async function probeFile(file) {
  const info = { file, duration: 0, hasVideo: false, hasAudio: false, width: 0, height: 0, audioTracks: [], covers: [] };
  try {
    const { stderr } = await runFfmpeg(['-hide_banner', '-i', file]);
    info.duration = parseDuration(stderr);
    for (const line of stderr.split(/\r?\n/)) {
      if (!line.includes('Stream #')) continue;
      if (line.includes('Video:')) {
        // 封面图（attached pic）不算视频流
        if (line.includes('attached pic')) {
          const index = line.match(/Stream #\d+:(\d+)/);
          const codec = line.match(/Video:\s*(\w+)/);
          if (index && codec) info.covers.push({ index: Number(index[1]), codec: codec[1] });
          continue;
        }
        info.hasVideo = true;
        if (!info.width) {
          const m = line.match(/,\s*(\d{2,5})x(\d{2,5})[\s[]/);
          if (m) {
            info.width = Number(m[1]);
            info.height = Number(m[2]);
          }
        }
      } else if (line.includes('Audio:')) {
        info.hasAudio = true;
        const lang = line.match(/Stream #\d+:\d+(?:\[[^\]]*\])?\(([^)]+)\)/);
        info.audioTracks.push({ language: lang ? lang[1] : 'und' });
      }
    }
  } catch {
    // 探测失败，按无流处理
  }
  return info;
}

// 合并输出文件名：merged_20260810-190530.mp4，避免覆盖已有文件
function buildMergeOutputPath(job) {
  const dir = job.outputDir || path.dirname(job.inputs[0]);
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
    + `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return uniqueOutputPath(path.join(dir, `merged_${ts}.${job.format}`), new Set(job.inputs.map(pathKey)));
}

// 字幕时长探测：ffmpeg -i 对字幕文件输出 Duration: N/A，
// 改为直接读取文本，取最后一个时间戳作为时长
function probeSubtitleDuration(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    let max = 0;
    // srt / vtt：00:01:23,456 或 00:01:23.456
    for (const m of text.matchAll(/(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})/g)) {
      const t = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
        + Number(m[4].padEnd(3, '0')) / 1000;
      if (t > max) max = t;
    }
    // vtt 简写：01:23.456（无小时位）
    for (const m of text.matchAll(/(?<![:\d])(\d{2}):(\d{2})[.,](\d{1,3})/g)) {
      const t = Number(m[1]) * 60 + Number(m[2]) + Number(m[3].padEnd(3, '0')) / 1000;
      if (t > max) max = t;
    }
    // ass / ssa：Dialogue: 0,0:01:23.45,...
    for (const m of text.matchAll(/(\d{1,2}):(\d{2}):(\d{2})\.(\d{1,2})/g)) {
      const t = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
        + Number(m[4].padEnd(2, '0')) / 100;
      if (t > max) max = t;
    }
    return max;
  } catch {
    return 0;
  }
}

// 先转义滤镜选项值，再转义整条滤镜图；spawn 参数数组不需要 shell 层转义。
function escapeSubtitleFilterPath(p) {
  const normalized = process.platform === 'win32' ? p.replace(/\\/g, '/') : p;
  return normalized.replace(/[\\':\s]/g, '\\$&').replace(/[\\'\[\],;\s]/g, '\\$&');
}

// 构造合并命令：混合队列用 concat filter 重编码拼接；
// 纯音频段生成等长黑屏视频（color 源），无音频的视频段生成静音（anullsrc）；
// 可选字幕：burn 烧录进画面（subtitles 滤镜），embed 内嵌为字幕轨（-c:s copy/mov_text）
function buildMergeArgs(job, probes, useX264) {
  validateAudioSelection(job, probes, true);
  const selected = selectedAudioTrack(job);
  // 按音轨序号拼接，缺少对应音轨的片段补静音；全部无音轨时保留原有静音输出。
  const trackIndices = selected === null
    ? Array.from({ length: Math.max(1, ...probes.map((p) => p.audioTracks.length)) }, (_, i) => i)
    : [selected];
  const sub = job.subtitle && job.subtitle.path ? job.subtitle : null;
  const burn = sub && sub.mode === 'burn';
  const anyVideo = probes.some((p) => p.hasVideo);
  const ref = probes.find((p) => p.hasVideo && p.width > 0);
  // 目标分辨率取第一个视频段的宽高（取偶，兼容 yuv420p）
  const W = ref ? Math.floor(ref.width / 2) * 2 : 1280;
  const H = ref ? Math.floor(ref.height / 2) * 2 : 720;

  const args = ['-hide_banner', '-n'];
  for (const f of job.inputs) args.push('-i', f);
  // 内嵌字幕轨时字幕作为普通输入，紧跟媒体输入之后（lavfi 输入索引相应后移）
  const subInputIdx = sub && !burn ? job.inputs.length : -1;
  if (subInputIdx >= 0) args.push('-i', sub.path);
  const lavfiBase = job.inputs.length + (subInputIdx >= 0 ? 1 : 0);

  const filters = [];
  const lavfi = []; // { kind: 'black'|'silence', duration }
  const segs = [];

  probes.forEach((p, i) => {
    if (anyVideo) {
      if (p.hasVideo) {
        filters.push(`[${i}:V:0]setpts=PTS-STARTPTS,scale=${W}:${H}:force_original_aspect_ratio=decrease,`
          + `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p[v${i}]`);
      } else {
        // 纯音频段：黑屏视频
        lavfi.push({ kind: 'black', duration: p.duration });
        filters.push(`[${lavfiBase + lavfi.length - 1}:v]format=yuv420p,setsar=1[v${i}]`);
      }
    }
    const audioLabels = [];
    trackIndices.forEach((track, outIndex) => {
      let source;
      if (p.audioTracks[track]) {
        source = `${i}:a:${track}`;
      } else {
        if (!(p.duration > 0)) throw new Error('缺失音轨的片段无法读取时长，不能补静音');
        lavfi.push({ kind: 'silence', duration: p.duration });
        source = `${lavfiBase + lavfi.length - 1}:a`;
      }
      const label = `a${i}_${outIndex}`;
      filters.push(`[${source}]asetpts=PTS-STARTPTS,aresample=44100,`
        + `aformat=sample_fmts=fltp:channel_layouts=stereo[${label}]`);
      audioLabels.push(`[${label}]`);
    });
    segs.push((anyVideo ? `[v${i}]` : '') + audioLabels.join(''));
  });

  // lavfi 输入按索引顺序追加在媒体（与字幕）输入之后
  for (const l of lavfi) {
    const t = Math.max(0.1, l.duration || 1).toFixed(2);
    if (l.kind === 'black') {
      args.push('-f', 'lavfi', '-t', t, '-i', `color=c=black:s=${W}x${H}:r=30`);
    } else {
      args.push('-f', 'lavfi', '-t', t, '-i', 'anullsrc=r=44100:cl=stereo');
    }
  }

  // 硬字幕：拼接完成后再经 subtitles 滤镜烧录进画面
  const catVideo = burn ? 'vcat' : 'vout';
  const audioOutputs = trackIndices.map((_, i) => `[aout${i}]`);
  filters.push(`${segs.join('')}concat=n=${probes.length}:v=${anyVideo ? 1 : 0}:a=${trackIndices.length}`
    + (anyVideo ? `[${catVideo}]` : '') + audioOutputs.join(''));
  if (burn) {
    filters.push(`[vcat]subtitles=filename=${escapeSubtitleFilterPath(sub.path)}[vout]`);
  }
  args.push('-filter_complex', filters.join(';'));

  if (anyVideo) {
    args.push('-map', '[vout]');
    for (const label of audioOutputs) args.push('-map', label);
    // 软字幕：字幕轨直接映射进容器，MKV 保留原编码，MP4 统一转 mov_text
    if (subInputIdx >= 0) args.push('-map', `${subInputIdx}:s`);
    if (useX264) {
      args.push('-c:v', 'libx264', '-crf', '20');
    }
    args.push('-c:a', 'aac');
    if (subInputIdx >= 0) args.push('-c:s', job.format === 'mkv' ? 'copy' : 'mov_text');
  } else {
    for (const label of audioOutputs) args.push('-map', label);
  }
  trackIndices.forEach((track, outIndex) => {
    const languages = new Set(probes.map((p) => p.audioTracks[track]?.language).filter(Boolean));
    // 同一序号语言一致才写入标签，避免为不同语言的拼接轨误标语言。
    if (languages.size === 1) args.push(`-metadata:s:a:${outIndex}`, `language=${[...languages][0]}`);
  });

  args.push('-nostats', '-progress', 'pipe:1', buildMergeOutputPath(job));
  return { args, anyVideo };
}

async function runMerge(sender, job) {
  cancelled = false;
  const send = (evt) => {
    if (!sender.isDestroyed()) sender.send('ffgui:convert-event', evt);
  };
  const fail = (msg) => {
    send({ type: 'file-error', index: 0, input: '合并任务', error: msg });
    return { total: 1, done: 0, cancelled: false };
  };

  const hasSubtitle = !!(job.subtitle && job.subtitle.path);
  if (!job.inputs || job.inputs.length < (hasSubtitle ? 1 : 2)) {
    return fail(hasSubtitle ? '合并至少需要 1 个音视频文件' : '合并至少需要 2 个文件');
  }

  const probes = await Promise.all(job.inputs.map(probeFile));
  if (probes.some((p) => !p.hasVideo && !p.hasAudio)) {
    return fail('队列中存在无法识别的文件（无音视频流）');
  }

  const anyVideo = probes.some((p) => p.hasVideo);
  if (hasSubtitle && !anyVideo) {
    return fail('纯音频合并不支持添加字幕，请先移除字幕文件');
  }
  if (anyVideo && AUDIO_ONLY_FORMATS.has(job.format)) {
    return fail('队列中包含视频文件，请选择视频输出格式（如 MP4/MKV）');
  }
  if (!anyVideo && !AUDIO_ONLY_FORMATS.has(job.format)) {
    return fail('队列为纯音频，请选择音频输出格式（如 MP3/FLAC）');
  }

  // libx264 可用则优先使用，否则交给容器默认编码器
  const caps = await getCapabilities();
  const useX264 = caps.encoders.video.some((e) => e.name === 'libx264');

  if (cancelled) return { total: 1, done: 0, cancelled: true };
  let args;
  try {
    ({ args } = buildMergeArgs(job, probes, useX264));
  } catch (err) {
    return fail(err.message);
  }
  const totalDuration = probes.reduce((sum, p) => sum + p.duration, 0);
  const output = args[args.length - 1];

  const result = await runFfmpegTask({
    args,
    index: 0,
    label: `合并 ${probes.length} 个文件`,
    output,
    getDuration: () => totalDuration,
    send,
    taskName: '合并',
  });
  return { total: 1, done: result.ok ? 1 : 0, cancelled };
}

// ---------- 音视频截取（无损切）/ 预览副本 / 抓帧 ----------

// 无损切：-ss 放 -i 前快速 seek，-c copy 流复制不重编码。
// 起点落在 <= start 的最近关键帧，可能有少许偏差（界面已提示）。
function buildClipArgs(job, outPath) {
  const duration = Math.max(0, job.end - job.start);
  return ['-hide_banner', '-n',
    '-ss', String(job.start),
    '-i', job.input,
    '-t', String(duration),
    '-map', '0',
    '-c', 'copy', '-avoid_negative_ts', 'make_zero',
    '-nostats', '-progress', 'pipe:1', outPath];
}

async function runClip(sender, job) {
  cancelled = false;
  const send = (evt) => {
    if (!sender.isDestroyed()) sender.send('ffgui:convert-event', evt);
  };
  const start = Number(job.start);
  const end = Number(job.end);
  if (!job.input || !(start >= 0) || !(end > start)) {
    send({ type: 'file-error', index: 0, input: '截取任务', error: '起止时间无效（终点必须大于起点）' });
    return { total: 1, done: 0, cancelled: false };
  }
  // 输出与源文件同目录同扩展名；同名时 buildOutputPath 自动加 _ffgui 后缀
  const ext = path.extname(job.input).slice(1).toLowerCase() || 'mp4';
  const outPath = buildOutputPath(job.input, job.outputDir, ext);
  const result = await runFfmpegTask({
    args: buildClipArgs({ input: job.input, start, end }, outPath),
    index: 0,
    label: job.input,
    output: outPath,
    getDuration: () => end - start,
    send,
    taskName: '截取',
  });
  return { total: 1, done: result.ok ? 1 : 0, cancelled };
}

// 预览副本：浏览器无法解码时兜底（wmv/flv，或封装了非常规编码的 mkv/avi 等；
// 普通 mkv Chromium 本身支持，不会走到这里），转一份低码率 mp4/m4a
// 供 <video> 播放定位。副本与原片时间轴 1:1 对齐，截取/截图仍作用于原文件。
function getPreviewDir() {
  return path.join(app.getPath('userData'), 'preview-cache');
}

async function runPreview(sender, job) {
  cancelled = false;
  const send = (evt) => {
    if (!sender.isDestroyed()) sender.send('ffgui:convert-event', evt);
  };
  const dir = getPreviewDir();
  fs.mkdirSync(dir, { recursive: true });
  // 单槽位：生成前清掉旧副本（旧副本可能正被 <video> 占用，删除失败则忽略）
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith('preview.')) {
      try { fs.unlinkSync(path.join(dir, name)); } catch { /* 占用中则忽略 */ }
    }
  }
  const outPath = path.join(dir, job.hasVideo ? 'preview.mp4' : 'preview.m4a');
  const args = ['-hide_banner', '-y', '-i', job.input];
  if (job.hasVideo) {
    args.push('-vf', "scale='min(960,iw)':-2", '-c:v', 'libx264',
      '-preset', 'ultrafast', '-crf', '30');
    if (job.hasAudio) args.push('-c:a', 'aac', '-b:a', '96k');
    else args.push('-an');
  } else {
    args.push('-vn', '-c:a', 'aac', '-b:a', '128k');
  }
  args.push('-nostats', '-progress', 'pipe:1', outPath);
  const result = await runFfmpegTask({
    args,
    index: 0,
    label: job.input,
    output: outPath,
    getDuration: () => Number(job.duration) || 0,
    send,
    taskName: '生成预览',
  });
  return { ok: result.ok, cancelled, output: result.ok ? outPath : null };
}

// ---------- IPC ----------

function registerIpc() {
  ipcMain.handle('ffgui:getCapabilities', () => getCapabilities());

  // 删除能力缓存文件，下次调用 getCapabilities 时重新探测
  ipcMain.handle('ffgui:clearCapsCache', () => {
    try {
      fs.unlinkSync(getCachePath());
      console.log('[ffgui] 已清除 ffmpeg 能力缓存');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      // 缓存本就不存在，视为已清除
    }
    return true;
  });

  ipcMain.handle('ffgui:pickMediaFiles', async (event) => {
    const win = require('electron').BrowserWindow.fromWebContents(event.sender);
    const res = await dialog.showOpenDialog(win, {
      title: '选择音视频文件',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '音视频文件', extensions: ['mp4', 'mkv', 'avi', 'mov', 'flv', 'wmv', 'webm', 'ts', 'm4v', 'mp3', 'aac', 'flac', 'wav', 'ogg', 'm4a', 'wma'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    return res.canceled ? [] : res.filePaths;
  });

  ipcMain.handle('ffgui:pickDirectory', async (event) => {
    const win = require('electron').BrowserWindow.fromWebContents(event.sender);
    const res = await dialog.showOpenDialog(win, {
      title: '选择输出目录',
      properties: ['openDirectory', 'createDirectory'],
    });
    return res.canceled ? null : res.filePaths[0];
  });

  ipcMain.handle('ffgui:convert', (event, job) => runJob(event.sender, job));

  // 媒体探测（合并页用于判断音/视频、时长、分辨率）
  ipcMain.handle('ffgui:probeMedia', (_event, files) => Promise.all(files.map(probeFile)));

  // 字幕文件选择与时长探测（ffmpeg -i 读不到字幕时长，直接解析文本时间戳）
  ipcMain.handle('ffgui:pickSubtitle', async (event) => {
    const win = require('electron').BrowserWindow.fromWebContents(event.sender);
    const res = await dialog.showOpenDialog(win, {
      title: '选择字幕文件',
      properties: ['openFile'],
      filters: [
        { name: '字幕文件', extensions: ['srt', 'ass', 'ssa', 'vtt'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    return res.canceled ? null : res.filePaths[0];
  });
  ipcMain.handle('ffgui:probeSubtitle', (_event, file) => probeSubtitleDuration(file));

  ipcMain.handle('ffgui:merge', (event, job) => runMerge(event.sender, job));

  // 截取（无损切）与预览副本（进度事件复用 convert-event，取消复用 cancelConvert）
  ipcMain.handle('ffgui:clip', (event, job) => runClip(event.sender, job));
  ipcMain.handle('ffgui:makePreview', (event, job) => runPreview(event.sender, job));

  // 抓帧截图：先弹保存对话框，再用 ffmpeg 从原文件按时间点抓一帧 PNG
  ipcMain.handle('ffgui:captureFrame', async (event, payload) => {
    const win = require('electron').BrowserWindow.fromWebContents(event.sender);
    const res = await dialog.showSaveDialog(win, {
      title: '另存为图像',
      defaultPath: payload.defaultName || 'frame.png',
      filters: [{ name: 'PNG 图像', extensions: ['png'] }],
    });
    if (res.canceled || !res.filePath) return null;
    // -ss 放 -i 前快速定位；输出为图像（重新编码单帧），时间点精确
    await runFfmpeg(['-hide_banner', '-y', '-ss', String(Number(payload.time) || 0),
      '-i', payload.input, '-frames:v', '1', res.filePath]);
    if (!fs.existsSync(res.filePath)) {
      throw new Error('抓帧失败，请检查该时间点是否存在画面');
    }
    console.log(`[ffgui] 已保存截图: ${res.filePath}`);
    return res.filePath;
  });

  ipcMain.handle('ffgui:cancelConvert', () => {
    cancelled = true;
    if (currentChild) currentChild.kill();
  });
}

module.exports = { registerIpc, getCapabilities };
