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
    // Apple Silicon 为 /opt/homebrew，Intel 为 /usr/local
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
const CACHE_VERSION = 3;

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
// 支持 -crf 质量参数的编码器
const CRF_ENCODERS = new Set(['libx264', 'libx265', 'libvpx-vp9', 'libaom-av1', 'libsvtav1']);
const CRF_MAP = { high: 18, medium: 23, low: 28 };
// VideoToolbox 不支持 -crf；Apple Silicon 上可用 -q:v（1-100，数值越大质量越高）
// Intel Mac 上传 -q:v 会直接报错（ffmpeg 源码 videotoolboxenc.c 限定 TARGET_CPU_ARM64），
// 因此仅在 darwin + arm64 下使用；其余平台码率留空时完全交给编码器默认值
const VT_QSCALE_MAP = { high: 80, medium: 65, low: 50 };
const VT_ENCODER_PATTERN = /_videotoolbox$/;
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

function buildOutputPath(input, outputDir, format) {
  const dir = outputDir || path.dirname(input);
  const base = path.basename(input, path.extname(input));
  let out = path.join(dir, `${base}.${format}`);
  if (path.resolve(out) === path.resolve(input)) {
    out = path.join(dir, `${base}_ffgui.${format}`);
  }
  return out;
}

function buildArgs(job, input, outPath) {
  const args = ['-hide_banner', '-y'];
  if (job.hwaccel) {
    args.push('-hwaccel', job.hwaccel);
  }
  args.push('-i', input);

  const audioOnly = AUDIO_ONLY_FORMATS.has(job.format);
  // 高级参数：码率（kbps），0/缺省表示不传入，由 ffmpeg 用默认值
  const vbitrate = Math.floor(Number(job.vbitrate)) || 0;
  const abitrate = Math.floor(Number(job.abitrate)) || 0;
  // 高级参数：分辨率，{w,h} 或 {percent}；null 表示不缩放（默认 100%）
  const scale = job.scale || null;

  // 视频
  if (audioOnly || job.vcodec === 'none') {
    args.push('-vn');
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

  // 视频滤镜链：仅在重编码视频时生效（copy/无视频/纯音频格式下跳过）
  // - HDR→SDR 勾选时加入色调映射链（zscale 线性光 → tonemap → bt709），未勾选完全不传
  // - 分辨率缩放（scale）追加在链尾
  const canFilter = !audioOnly && job.vcodec !== 'copy' && job.vcodec !== 'none';
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
      vf.push(`scale=${w}:${h}`);
    } else if (percent > 0 && percent !== 100) {
      // 百分比缩放；取偶数尺寸避免 yuv420p 编码器报错
      vf.push(`scale=trunc(iw*${percent}/200)*2:trunc(ih*${percent}/200)*2`);
    }
  }
  if (vf.length > 0) {
    args.push('-vf', vf.join(','));
  }

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
      let kv = {};
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
        const duration = getDuration();
        const timeSec = kv.out_time ? parseTimeToSeconds(kv.out_time) : 0;
        const percent = duration > 0 ? Math.min(99, Math.round((timeSec / duration) * 100)) : 0;
        send({
          type: 'progress',
          index,
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
      if (code === 0) {
        console.log(`[ffgui] ${taskName}完成 (${index + 1}): ${output}`);
        send({ type: 'file-done', index, input: label, output });
        resolve({ ok: true });
      } else {
        console.log(`[ffgui] ${taskName}失败 (${index + 1})，退出码 ${code}: ${label}`);
        const tail = stderrTail.split(/\r?\n/).filter(Boolean).slice(-5).join('\n');
        send({ type: 'file-error', index, input: label, error: `ffmpeg 退出码 ${code}\n${tail}` });
        resolve({ ok: false });
      }
    });
  });
}

function convertOne(job, input, index, send) {
  const outPath = buildOutputPath(input, job.outputDir, job.format);
  const args = buildArgs(job, input, outPath);
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
  cancelled = false;
  const results = [];
  for (let i = 0; i < job.inputs.length; i++) {
    if (cancelled) break;
    results.push(await convertOne(job, job.inputs[i], i, (evt) => {
      if (!sender.isDestroyed()) sender.send('ffgui:convert-event', evt);
    }));
  }
  const done = results.filter((r) => r && r.ok).length;
  return { total: job.inputs.length, done, cancelled };
}

// ---------- 媒体探测 / 音视频合并 ----------

// 用 ffmpeg -i 的 stderr 探测媒体信息（时长、有无音视频流、分辨率）
async function probeFile(file) {
  const info = { file, duration: 0, hasVideo: false, hasAudio: false, width: 0, height: 0 };
  try {
    const { stderr } = await runFfmpeg(['-hide_banner', '-i', file]);
    info.duration = parseDuration(stderr);
    for (const line of stderr.split(/\r?\n/)) {
      if (!line.includes('Stream #')) continue;
      if (line.includes('Video:')) {
        // 封面图（attached pic）不算视频流
        if (line.includes('attached pic')) continue;
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
  return path.join(dir, `merged_${ts}.${job.format}`);
}

// 构造合并命令：混合队列用 concat filter 重编码拼接；
// 纯音频段生成等长黑屏视频（color 源），无音频的视频段生成静音（anullsrc）
function buildMergeArgs(job, probes, useX264) {
  const anyVideo = probes.some((p) => p.hasVideo);
  const ref = probes.find((p) => p.hasVideo && p.width > 0);
  // 目标分辨率取第一个视频段的宽高（取偶，兼容 yuv420p）
  const W = ref ? Math.floor(ref.width / 2) * 2 : 1280;
  const H = ref ? Math.floor(ref.height / 2) * 2 : 720;

  const args = ['-hide_banner', '-y'];
  for (const f of job.inputs) args.push('-i', f);

  const filters = [];
  const lavfi = []; // { kind: 'black'|'silence', duration }
  const segs = [];

  probes.forEach((p, i) => {
    if (anyVideo) {
      if (p.hasVideo) {
        filters.push(`[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,`
          + `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p[v${i}]`);
      } else {
        // 纯音频段：黑屏视频
        lavfi.push({ kind: 'black', duration: p.duration });
        filters.push(`[${job.inputs.length + lavfi.length - 1}:v]format=yuv420p,setsar=1[v${i}]`);
      }
      if (p.hasAudio) {
        filters.push(`[${i}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
      } else {
        // 无音频轨的视频段：静音
        lavfi.push({ kind: 'silence', duration: p.duration });
        filters.push(`[${job.inputs.length + lavfi.length - 1}:a]`
          + 'aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo'
          + `[a${i}]`);
      }
      segs.push(`[v${i}][a${i}]`);
    } else {
      // 纯音频队列：只拼接音频
      filters.push(`[${i}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
      segs.push(`[a${i}]`);
    }
  });

  // lavfi 输入按索引顺序追加在媒体输入之后
  for (const l of lavfi) {
    const t = Math.max(0.1, l.duration || 1).toFixed(2);
    if (l.kind === 'black') {
      args.push('-f', 'lavfi', '-t', t, '-i', `color=c=black:s=${W}x${H}:r=30`);
    } else {
      args.push('-f', 'lavfi', '-t', t, '-i', 'anullsrc=r=44100:cl=stereo');
    }
  }

  filters.push(`${segs.join('')}concat=n=${probes.length}:v=${anyVideo ? 1 : 0}:a=1`
    + (anyVideo ? '[vout][aout]' : '[aout]'));
  args.push('-filter_complex', filters.join(';'));

  if (anyVideo) {
    args.push('-map', '[vout]', '-map', '[aout]');
    if (useX264) {
      args.push('-c:v', 'libx264', '-crf', '20');
    }
    args.push('-c:a', 'aac');
  } else {
    args.push('-map', '[aout]');
  }

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

  if (!job.inputs || job.inputs.length < 2) {
    return fail('合并至少需要 2 个文件');
  }

  const probes = await Promise.all(job.inputs.map(probeFile));
  if (probes.some((p) => !p.hasVideo && !p.hasAudio)) {
    return fail('队列中存在无法识别的文件（无音视频流）');
  }

  const anyVideo = probes.some((p) => p.hasVideo);
  if (anyVideo && AUDIO_ONLY_FORMATS.has(job.format)) {
    return fail('队列中包含视频文件，请选择视频输出格式（如 MP4/MKV）');
  }
  if (!anyVideo && !AUDIO_ONLY_FORMATS.has(job.format)) {
    return fail('队列为纯音频，请选择音频输出格式（如 MP3/FLAC）');
  }

  // libx264 可用则优先使用，否则交给容器默认编码器
  const caps = await getCapabilities();
  const useX264 = caps.encoders.video.some((e) => e.name === 'libx264');

  const { args } = buildMergeArgs(job, probes, useX264);
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

  ipcMain.handle('ffgui:merge', (event, job) => runMerge(event.sender, job));

  ipcMain.handle('ffgui:cancelConvert', () => {
    cancelled = true;
    if (currentChild) currentChild.kill();
  });
}

module.exports = { registerIpc, getCapabilities };
