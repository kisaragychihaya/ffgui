const { app, ipcMain, dialog, desktopCapturer, session } = require('electron');
const { spawn, execFile, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
// 主进程文案（报错 / 警告 / 文件对话框标题）由 locales/<lng>.json 提供
const { t } = require('./i18n');

// ffmpeg 可执行文件路径：
// - Windows：内置 bin/ffmpeg.exe（开发时读项目根 bin/，打包后经 extraResource 在 resources/bin/）
// - macOS：使用 Homebrew 安装的 ffmpeg（brew install ffmpeg）
// - Linux：使用系统 PATH 中的 ffmpeg
function getFfmpegPath() {
  if (process.platform === 'win32') {
    // extraResource 以文件形式只携带 ffmpeg.exe（不带未使用的 ffprobe），
    // 打包后位于 resources/ 根目录；兼容旧布局 resources/bin/ffmpeg.exe
    const base = app.isPackaged ? process.resourcesPath : app.getAppPath();
    if (app.isPackaged) {
      const flat = path.join(base, 'ffmpeg.exe');
      if (fs.existsSync(flat)) return flat;
    }
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
    const trimmed = line.trim();
    if (!started) {
      if (/hardware acceleration methods/i.test(trimmed)) started = true;
      continue;
    }
    if (trimmed) result.push(trimmed);
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
    throw new Error(t('main.err.ffmpegMissing'));
  }
  // 带路径分隔符的才做存在性检查（裸命令名靠 PATH 解析）
  if (ffmpeg.includes(path.sep) && !fs.existsSync(ffmpeg)) {
    throw new Error(t('main.err.ffmpegPathMissing', { path: ffmpeg }));
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
  if (!Number.isSafeInteger(track) || track < 1) throw new Error(t('main.err.audioTrackInteger'));
  return track - 1;
}

function validateAudioSelection(job, probes, merging = false) {
  if (VIDEO_ONLY_FORMATS.has(job.format) || job.acodec === 'none') return;
  const track = selectedAudioTrack(job);
  const count = (p) => p.audioTracks.length;
  if (track === null && SINGLE_AUDIO_FORMATS.has(job.format) && probes.some((p) => count(p) > 1)) {
    throw new Error(t('main.err.audioTrackRequired', { format: job.format.toUpperCase() }));
  }
  if (track !== null && (merging ? !probes.some((p) => count(p) > track) : probes.some((p) => count(p) <= track))) {
    throw new Error(t('main.err.audioTrackMissing', { n: track + 1 }));
  }
}

// 设备/平台预设表：主进程按表落实全部锁定参数，不能只依赖界面填值；
// 须在分配输出扩展名前调用。新增预设时渲染层 convert.js 的同名表同步维护。
const DEVICE_PRESETS = {
  // iPod touch 4 / iOS 6（保持比例缩放，分辨率上限两档）
  'ipod4-540': { format: 'mp4', vcodec: 'libx264', acodec: 'aac', hwaccel: '',
    pixFmt: 'yuv420p', h264Profile: 'main', h264Level: '3.1', fps: '', maxFps: 30,
    scale: { w: 960, h: 540 }, fitScale: true, vbitrate: 2000, vrateMode: 'vbr',
    maxrate: 3000, bufsize: 6000, abitrate: 128, channels: 2, sampleRate: 48000 },
  'ipod4-720': { format: 'mp4', vcodec: 'libx264', acodec: 'aac', hwaccel: '',
    pixFmt: 'yuv420p', h264Profile: 'main', h264Level: '3.1', fps: '', maxFps: 30,
    scale: { w: 1280, h: 720 }, fitScale: true, vbitrate: 2000, vrateMode: 'vbr',
    maxrate: 3000, bufsize: 6000, abitrate: 128, channels: 2, sampleRate: 48000 },
  // B站 1080P 投稿：平台均值 ≤6000 kbps / 峰值 ≤24000 / 音频 ≤320 kbps，免二压上限
  'bili-1080p': { format: 'mp4', vcodec: 'libx264', acodec: 'aac', hwaccel: '',
    pixFmt: 'yuv420p', h264Profile: 'high', h264Level: '4.2', fps: '', maxFps: 60,
    scale: { w: 1920, h: 1080 }, fitScale: true, vbitrate: 6000, vrateMode: 'vbr',
    maxrate: 12000, bufsize: 24000, abitrate: 320, channels: 2, sampleRate: 48000 },
  // B站 720P 投稿
  'bili-720p': { format: 'mp4', vcodec: 'libx264', acodec: 'aac', hwaccel: '',
    pixFmt: 'yuv420p', h264Profile: 'high', h264Level: '3.1', fps: '', maxFps: 30,
    scale: { w: 1280, h: 720 }, fitScale: true, vbitrate: 3000, vrateMode: 'vbr',
    maxrate: 6000, bufsize: 12000, abitrate: 192, channels: 2, sampleRate: 48000 },
  // 抖音/快手 1080P（平台建议 1080p、30/60 fps、H.264、码率 2–8 Mbps）
  'douyin-1080p': { format: 'mp4', vcodec: 'libx264', acodec: 'aac', hwaccel: '',
    pixFmt: 'yuv420p', h264Profile: 'high', h264Level: '4.2', fps: '', maxFps: 60,
    scale: { w: 1920, h: 1080 }, fitScale: true, vbitrate: 6000, vrateMode: 'vbr',
    maxrate: 12000, bufsize: 24000, abitrate: 192, channels: 2, sampleRate: 48000 },
  // 微信视频号 1080P
  'wechat-1080p': { format: 'mp4', vcodec: 'libx264', acodec: 'aac', hwaccel: '',
    pixFmt: 'yuv420p', h264Profile: 'high', h264Level: '4.0', fps: '', maxFps: 30,
    scale: { w: 1920, h: 1080 }, fitScale: true, vbitrate: 4000, vrateMode: 'vbr',
    maxrate: 8000, bufsize: 16000, abitrate: 128, channels: 2, sampleRate: 48000 },
  // YouTube 1080P（官方建议 1080p30 8 Mbps / 1080p60 12 Mbps，AAC ≤384 kbps）
  'youtube-1080p': { format: 'mp4', vcodec: 'libx264', acodec: 'aac', hwaccel: '',
    pixFmt: 'yuv420p', h264Profile: 'high', h264Level: '4.2', fps: '', maxFps: 60,
    scale: { w: 1920, h: 1080 }, fitScale: true, vbitrate: 8000, vrateMode: 'vbr',
    maxrate: 12000, bufsize: 24000, abitrate: 384, channels: 2, sampleRate: 48000 },
  // iPhone 4S / iOS 6（Apple 官方 1080p30 播放上限：High ≤4.0，AAC-LC ≤160 kbps）
  'iphone4s': { format: 'mp4', vcodec: 'libx264', acodec: 'aac', hwaccel: '',
    pixFmt: 'yuv420p', h264Profile: 'high', h264Level: '4.0', fps: '', maxFps: 30,
    scale: { w: 1920, h: 1080 }, fitScale: true, vbitrate: 4000, vrateMode: 'vbr',
    maxrate: 8000, bufsize: 16000, abitrate: 160, channels: 2, sampleRate: 48000 },
  // PSP：H.264 Main 2.2 / 480×272，AAC-LC 48 kHz
  'psp': { format: 'mp4', vcodec: 'libx264', acodec: 'aac', hwaccel: '',
    pixFmt: 'yuv420p', h264Profile: 'main', h264Level: '2.2', fps: '', maxFps: 30,
    scale: { w: 480, h: 272 }, fitScale: true, vbitrate: 1000, vrateMode: 'vbr',
    maxrate: 1500, bufsize: 3000, abitrate: 128, channels: 2, sampleRate: 48000 },
  // 老款安卓（2.x 时代）：Baseline 2.1 / 800×480
  'android-legacy': { format: 'mp4', vcodec: 'libx264', acodec: 'aac', hwaccel: '',
    pixFmt: 'yuv420p', h264Profile: 'baseline', h264Level: '2.1', fps: '', maxFps: 30,
    scale: { w: 800, h: 480 }, fitScale: true, vbitrate: 1000, vrateMode: 'vbr',
    maxrate: 1500, bufsize: 3000, abitrate: 128, channels: 2, sampleRate: 44100 },
  // 最大兼容（网页嵌入 / 老旧播放设备）：Baseline 3.0 / 720p
  'web-safe': { format: 'mp4', vcodec: 'libx264', acodec: 'aac', hwaccel: '',
    pixFmt: 'yuv420p', h264Profile: 'baseline', h264Level: '3.0', fps: '', maxFps: 30,
    scale: { w: 1280, h: 720 }, fitScale: true, vbitrate: 2500, vrateMode: 'vbr',
    maxrate: 5000, bufsize: 10000, abitrate: 128, channels: 2, sampleRate: 44100 },
  // 4K 电视/盒子（兼 B站 4K 投稿：平台建议均值 20000 kbps）
  'tv-4k': { format: 'mp4', vcodec: 'libx264', acodec: 'aac', hwaccel: '',
    pixFmt: 'yuv420p', h264Profile: 'high', h264Level: '5.1', fps: '', maxFps: 30,
    scale: { w: 3840, h: 2160 }, fitScale: true, vbitrate: 20000, vrateMode: 'vbr',
    maxrate: 40000, bufsize: 60000, abitrate: 192, channels: 2, sampleRate: 48000 },
};

// 预设在主进程再次落实，不能只依赖界面填值；必须在生成输出扩展名前调用。
function normalizeConvertJob(job) {
  if (!job.devicePreset) return { ...job };
  const preset = DEVICE_PRESETS[job.devicePreset];
  if (!preset) throw new Error(t('main.err.unknownDevicePreset'));
  // 预设表内的锁定参数覆盖旧表单值（format/vcodec/.../sampleRate）
  return { ...job, ...preset };
}

// 可视化裁剪的归一化矩形：{x, y, w, h}，相对于视频实际画面（0~1，与像素无关，
// 低画质预览副本上选择的数值同样适用）。x/y 为左上角坐标，w/h 为宽高。
// 边界容差：只吸收浮点误差，避免 0.1+0.2 这类运算误差被误判为越界
const CROP_EPS = 1e-6;

// 校验并归一化 crop；非法时抛出本地化错误。返回 null 表示未裁剪
function normalizeCrop(crop) {
  if (crop == null) return null;
  if (typeof crop !== 'object' || Array.isArray(crop)) throw new Error(t('main.err.cropFormat'));
  const value = {};
  for (const key of ['x', 'y', 'w', 'h']) {
    const v = crop[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      const field = { x: 'X', y: 'Y', w: t('main.label.cropWidth'), h: t('main.label.cropHeight') }[key];
      throw new Error(t('main.err.cropFieldInvalid', { field }));
    }
    value[key] = v;
  }
  if (value.x < 0 || value.y < 0) throw new Error(t('main.err.cropNegative'));
  if (value.w <= 0 || value.h <= 0) throw new Error(t('main.err.cropZeroSize'));
  if (value.x + value.w > 1 + CROP_EPS) throw new Error(t('main.err.cropRightEdge'));
  if (value.y + value.h > 1 + CROP_EPS) throw new Error(t('main.err.cropBottomEdge'));
  return value;
}

// 把归一化裁剪矩形转成 ffmpeg 的 crop 滤镜表达式。
// 基于滤镜实际输入尺寸（in_w/in_h，可能是 scale 之前的原始分辨率）计算：
// - 起点 x/y 按比例换算后取整，并钳制在 [0, in_w-out_w] / [0, in_h-out_h] 内，
//   保证 x+w / y+h 不超出实际帧（尤其是宽高被 max(2,...) 抬到 2 的极小选框）
// - 宽高按比例换算后向下取偶数（兼容 yuv420p 等子采样格式），再用 max(2,...) 兜底：
//   极小但合法的选框（如 100x100 视频上 1% 的框）取偶后会是 0，FFmpeg 直接报
//   non positive size 而失败
// 注意滤镜选项值里的逗号必须写成 "\,"，否则会被当作滤镜分隔符导致解析失败
function buildCropFilter(crop) {
  const c = normalizeCrop(crop);
  if (!c) return null;
  // 四个字段已通过 Number.isFinite 校验，String() 只会得到数字字面量，
  // 不会把未经校验的字符串拼进滤镜表达式
  const { x, y, w, h } = c;
  return `crop=w=max(2\\,trunc(in_w*${String(w)}/2)*2)`
    + `:h=max(2\\,trunc(in_h*${String(h)}/2)*2)`
    + `:x=max(0\\,min(trunc(in_w*${String(x)})\\,in_w-out_w))`
    + `:y=max(0\\,min(trunc(in_h*${String(y)})\\,in_h-out_h))`;
}

function validateConvertOptions(job) {
  const video = !AUDIO_ONLY_FORMATS.has(job.format) && job.vcodec !== 'none';
  const audio = !VIDEO_ONLY_FORMATS.has(job.format) && job.acodec !== 'none';
  // 裁剪区域先做白名单校验：无论输出是否含视频，非法值一律拒绝；
  // 纯音频/无视频分支只是忽略 crop，不会把它拼进滤镜链
  const crop = normalizeCrop(job.crop);
  if (video) {
    if (job.vcodec === 'copy' && crop) {
      throw new Error(t('main.err.copyWithCrop'));
    }
    if (job.vcodec === 'copy' && (job.pixFmt || job.h264Profile || job.h264Level || job.fps || job.scale || job.hdr2sdr)) {
      throw new Error(t('main.err.copyWithVideoOptions'));
    }
    if (job.pixFmt && !['yuv420p', 'yuv420p10le'].includes(job.pixFmt)) throw new Error(t('main.err.pixFmt'));
    if (job.h264Profile || job.h264Level) {
      if (job.vcodec !== 'libx264') throw new Error(t('main.err.profileNeedsX264'));
      if (job.h264Profile && !['baseline', 'main', 'high', 'high10'].includes(job.h264Profile)) throw new Error(t('main.err.h264Profile'));
      if (job.h264Level && !['2.1', '2.2', '3.0', '3.1', '4.0', '4.1', '4.2', '5.0', '5.1', '5.2'].includes(job.h264Level)) throw new Error(t('main.err.h264Level'));
      if (job.pixFmt === 'yuv420p10le' && ['baseline', 'main', 'high'].includes(job.h264Profile)) {
        throw new Error(t('main.err.profile10bit'));
      }
    }
    if (job.fps) {
      const fpsNum = Number(job.fps);
      if (!isFinite(fpsNum) || fpsNum <= 0 || fpsNum > 240) throw new Error(t('main.err.fps'));
    }
  }
  if (audio) {
    if (job.acodec === 'copy' && (job.channels || job.sampleRate)) throw new Error(t('main.err.copyWithAudioOptions'));
    if (job.channels && ![1, 2, 6].includes(Number(job.channels))) throw new Error(t('main.err.channels'));
    if (job.sampleRate && ![22050, 32000, 44100, 48000, 96000].includes(Number(job.sampleRate))) throw new Error(t('main.err.sampleRate'));
  }
  if (job.format === 'mp3' && job.id3Version && !['3', '4'].includes(String(job.id3Version))) throw new Error(t('main.err.id3Version'));
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
  // 仅供主进程内部任务显式启用；普通转码任务的默认行为不变。
  if (job.preserveChapters === true) args.push('-map_chapters', '0');
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
  // - 可视化裁剪（crop）位于链首，基于滤镜实际输入尺寸按归一化比例换算
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
  // 可视化裁剪：取画面实际尺寸的归一化比例，必须放在滤镜链最前面，
  // 后续 HDR→SDR / scale 都在裁剪后的画面上进行
  const cropFilter = canFilter ? buildCropFilter(job.crop) : null;
  if (cropFilter) vf.push(cropFilter);
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

// 取消后清理本次任务写出的半成品：任务开始前已存在的文件、空路径一律跳过，
// 删除失败只记日志，绝不改变取消结果
function removeCancelledOutput(output, existedBefore) {
  if (!output || existedBefore) return;
  try {
    fs.unlinkSync(output);
    console.log(`[ffgui] 已删除未完成的输出: ${output}`);
  } catch (err) {
    // 文件没生成出来（ENOENT）属正常情况，其余失败只记录
    if (err && err.code === 'ENOENT') return;
    console.log(`[ffgui] 删除未完成的输出失败: ${output} (${err && err.message ? err.message : err})`);
  }
}

// 取消当前任务：置取消标记并结束子进程，close 回调里再清理半成品输出
function cancelCurrentTask() {
  cancelled = true;
  if (currentChild) currentChild.kill();
}

// 通用 ffmpeg 任务执行器：spawn、stderr 日志转发、-progress 解析、结束处理
// taskName 用于控制台日志措辞（转换/合并）
function runFfmpegTask({ args, index, label, output, getDuration, onStderrText, send, taskName }) {
  return new Promise((resolve) => {
    // spawn 前记录 output 是否已存在：取消清理只删本次新产生的文件
    const outputExisted = Boolean(output) && fs.existsSync(output);
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
        // 取消时清掉本次任务已写出的半成品，避免磁盘残留无法播放的残缺文件
        removeCancelledOutput(output, outputExisted);
        console.log(`[ffgui] 已取消 (${index + 1}): ${label}`);
        send({ type: 'file-error', index, input: label, error: t('main.err.cancelled') });
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
        const reason = code === 0
          ? t('main.err.ffmpegIncompleteOutput')
          : t('main.err.ffmpegExitCode', { code });
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
      send({ type: 'file-warning', index, input, warning: t('main.warn.coverUnsupported') });
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

// 主进程内部单文件转换入口：光盘等任务可直接复用，不新增渲染层 IPC。
async function runSingleFileConversion({ job, input, output, send = () => {} }) {
  cancelled = false;
  return convertOne(job, input, 0, send, output);
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
      const sec = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
        + Number(m[4].padEnd(3, '0')) / 1000;
      if (sec > max) max = sec;
    }
    // vtt 简写：01:23.456（无小时位）
    for (const m of text.matchAll(/(?<![:\d])(\d{2}):(\d{2})[.,](\d{1,3})/g)) {
      const sec = Number(m[1]) * 60 + Number(m[2]) + Number(m[3].padEnd(3, '0')) / 1000;
      if (sec > max) max = sec;
    }
    // ass / ssa：Dialogue: 0,0:01:23.45,...
    for (const m of text.matchAll(/(\d{1,2}):(\d{2}):(\d{2})\.(\d{1,2})/g)) {
      const sec = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
        + Number(m[4].padEnd(2, '0')) / 100;
      if (sec > max) max = sec;
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
        if (!(p.duration > 0)) throw new Error(t('main.err.mergeMissingDuration'));
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
    const dur = Math.max(0.1, l.duration || 1).toFixed(2);
    if (l.kind === 'black') {
      args.push('-f', 'lavfi', '-t', dur, '-i', `color=c=black:s=${W}x${H}:r=30`);
    } else {
      args.push('-f', 'lavfi', '-t', dur, '-i', 'anullsrc=r=44100:cl=stereo');
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
    send({ type: 'file-error', index: 0, input: t('main.label.mergeTask'), error: msg });
    return { total: 1, done: 0, cancelled: false };
  };

  const hasSubtitle = !!(job.subtitle && job.subtitle.path);
  if (!job.inputs || job.inputs.length < (hasSubtitle ? 1 : 2)) {
    return fail(hasSubtitle ? t('main.err.mergeNeedOne') : t('main.err.mergeNeedTwo'));
  }

  const probes = await Promise.all(job.inputs.map(probeFile));
  if (probes.some((p) => !p.hasVideo && !p.hasAudio)) {
    return fail(t('main.err.mergeUnrecognized'));
  }

  const anyVideo = probes.some((p) => p.hasVideo);
  if (hasSubtitle && !anyVideo) {
    return fail(t('main.err.mergeAudioSubtitle'));
  }
  if (anyVideo && AUDIO_ONLY_FORMATS.has(job.format)) {
    return fail(t('main.err.mergeVideoFormat'));
  }
  if (!anyVideo && !AUDIO_ONLY_FORMATS.has(job.format)) {
    return fail(t('main.err.mergeAudioFormat'));
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
    label: t('main.label.mergeFiles', { n: probes.length }),
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
    send({ type: 'file-error', index: 0, input: t('main.label.clipTask'), error: t('main.err.clipTimeInvalid') });
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

// ---------- 屏幕录制（分块写盘 / 转 MP4） ----------

// getDisplayMedia 授权：渲染进程在来源选择弹窗里选定后，先经 ffgui:prepareDesktopSource
// 登记来源 id，紧接着调用 getDisplayMedia，这里按登记授予对应来源。
// （Electron 的 useSystemPicker 仅 macOS 15+ 有效，Windows/Linux 必须由 handler
// 提供 desktopCapturer 来源；系统声音用 'loopback' 回环采集，仅 Windows/Linux 有效，
// macOS 无系统级回环，只能录麦克风）
let pendingDesktopSourceId = null;

function registerDisplayMediaHandler() {
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    (async () => {
      if (!request.frame || !pendingDesktopSourceId) return null;
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
      return sources.find((s) => s.id === pendingDesktopSourceId) || null;
    })()
      .then((src) => {
        pendingDesktopSourceId = null;
        if (!src) return callback(null);
        const streams = { video: src };
        // 'loopback' 系统声音回环仅 Windows 支持（Electron 文档明确），macOS/Linux 不授予
        if (request.audioRequested && process.platform === 'win32') {
          streams.audio = 'loopback';
        }
        console.log(`[ffgui] getDisplayMedia 授权: ${src.id}`
          + (streams.audio ? '，含系统声音回环' : '，无系统声音'));
        callback(streams);
      })
      .catch(() => {
        pendingDesktopSourceId = null;
        callback(null);
      });
  });
}

// 录制输出流：path -> WriteStream。渲染进程 MediaRecorder 按 1s 分块经 IPC 流式追加，
// 每次 write 等回调返回（背压），长录制不会撑爆内存
const recordStreams = new Map();

// 录制结果转 MP4：视频流无损复制（VP9 封装进 MP4），Opus 重封装为 AAC（MP4 不支持 Opus）
async function runRecordRemux(sender, input) {
  cancelled = false;
  const send = (evt) => {
    if (!sender.isDestroyed()) sender.send('ffgui:convert-event', evt);
  };
  const probe = await probeFile(input);
  if (!probe.hasVideo) {
    send({ type: 'file-error', index: 0, input, error: t('main.err.recordNoVideo') });
    return { done: 0, cancelled: false, output: null };
  }
  const outPath = buildOutputPath(input, null, 'mp4');
  const args = ['-hide_banner', '-y', '-i', input, '-c:v', 'copy'];
  if (probe.hasAudio) {
    args.push('-c:a', 'aac', '-b:a', '128k');
  } else {
    args.push('-an');
  }
  args.push('-nostats', '-progress', 'pipe:1', outPath);
  const result = await runFfmpegTask({
    args,
    index: 0,
    label: input,
    output: outPath,
    getDuration: () => probe.duration,
    send,
    taskName: '转 MP4',
  });
  return { done: result.ok ? 1 : 0, cancelled, output: result.ok ? outPath : null };
}

// ---------- IPC ----------

function registerIpc() {
  registerDisplayMediaHandler();

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
      title: t('main.dialog.pickMedia'),
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: t('main.dialog.filterMedia'), extensions: ['mp4', 'mkv', 'avi', 'mov', 'flv', 'wmv', 'webm', 'ts', 'm4v', 'mp3', 'aac', 'flac', 'wav', 'ogg', 'm4a', 'wma'] },
        { name: t('main.dialog.filterAllFiles'), extensions: ['*'] },
      ],
    });
    return res.canceled ? [] : res.filePaths;
  });

  ipcMain.handle('ffgui:pickDirectory', async (event) => {
    const win = require('electron').BrowserWindow.fromWebContents(event.sender);
    const res = await dialog.showOpenDialog(win, {
      title: t('main.dialog.pickDirectory'),
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
      title: t('main.dialog.pickSubtitle'),
      properties: ['openFile'],
      filters: [
        { name: t('main.dialog.filterSubtitle'), extensions: ['srt', 'ass', 'ssa', 'vtt'] },
        { name: t('main.dialog.filterAllFiles'), extensions: ['*'] },
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
      title: t('main.dialog.saveFrame'),
      defaultPath: payload.defaultName || 'frame.png',
      filters: [{ name: t('main.dialog.filterPng'), extensions: ['png'] }],
    });
    if (res.canceled || !res.filePath) return null;
    // -ss 放 -i 前快速定位；输出为图像（重新编码单帧），时间点精确
    await runFfmpeg(['-hide_banner', '-y', '-ss', String(Number(payload.time) || 0),
      '-i', payload.input, '-frames:v', '1', res.filePath]);
    if (!fs.existsSync(res.filePath)) {
      throw new Error(t('main.err.captureFrameFailed'));
    }
    console.log(`[ffgui] 已保存截图: ${res.filePath}`);
    return res.filePath;
  });

  // ---------- 屏幕录制 ----------
  // 渲染进程 getDisplayMedia + MediaRecorder 采集编码（WebM），分块流式写入主进程

  // 输出位置：默认「视频/record_时间戳.webm」
  ipcMain.handle('ffgui:recordPickOutput', async (event) => {
    const win = require('electron').BrowserWindow.fromWebContents(event.sender);
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
      + `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    const res = await dialog.showSaveDialog(win, {
      title: t('main.dialog.recordOutput'),
      defaultPath: path.join(app.getPath('videos'), `record_${ts}.webm`),
      filters: [{ name: t('main.dialog.filterWebm'), extensions: ['webm'] }],
    });
    return res.canceled || !res.filePath ? null : res.filePath;
  });

  // 开始录制写盘：显式创建输出流。同路径已有流则报错——配合渲染层的防重入，
  // 杜绝两个录制写同一文件造成截断损坏
  ipcMain.handle('ffgui:recordStart', (_event, targetPath) => {
    if (recordStreams.has(targetPath)) {
      throw new Error(t('main.err.recordBusy'));
    }
    const stream = fs.createWriteStream(targetPath);
    recordStreams.set(targetPath, stream);
    console.log(`[ffgui] 录制写盘开始: ${targetPath}`);
    return true;
  });

  // 追加一个录制分块；写流必须已由 recordStart 创建，绝不事后新建（'w' 会截断
  // 已完成的文件）——停止后迟到的分块在这里被拒绝；write 回调返回前不 resolve（背压）
  ipcMain.handle('ffgui:recordWriteChunk', (event, targetPath, buf) => new Promise((resolve, reject) => {
    const stream = recordStreams.get(targetPath);
    if (!stream) {
      reject(new Error(t('main.err.recordStreamMissing')));
      return;
    }
    stream.write(Buffer.from(buf), (err) => {
      if (err) {
        recordStreams.delete(targetPath);
        reject(err);
      } else {
        resolve(true);
      }
    });
  }));

  // 录制结束：关闭写流，返回文件大小
  ipcMain.handle('ffgui:recordFinish', (event, targetPath) => new Promise((resolve) => {
    const stream = recordStreams.get(targetPath);
    const done = (ok) => {
      let size = 0;
      try {
        size = fs.statSync(targetPath).size;
      } catch {
        // 文件不存在则按失败处理
        ok = false;
      }
      if (ok) {
        console.log(`[ffgui] 录制已保存: ${targetPath} (${(size / 1024 / 1024).toFixed(1)} MB)`);
      }
      resolve({ ok, path: targetPath, size });
    };
    if (!stream) {
      done(false);
      return;
    }
    recordStreams.delete(targetPath);
    stream.once('error', () => done(false));
    stream.end(() => done(true));
  }));

  // 取消 / 出错：丢弃半成品文件
  ipcMain.handle('ffgui:recordDiscard', (_event, targetPath) => {
    const stream = recordStreams.get(targetPath);
    recordStreams.delete(targetPath);
    if (stream) stream.destroy();
    try {
      fs.unlinkSync(targetPath);
    } catch {
      // 文件不存在（如尚未写入分块）则忽略
    }
    console.log(`[ffgui] 已丢弃未完成的录制: ${targetPath}`);
    return true;
  });

  // 录制结果转 MP4（视频流复制 + 音频转 AAC；进度事件复用 convert-event）
  ipcMain.handle('ffgui:recordRemux', (event, input) => runRecordRemux(event.sender, input));

  // 来源选择弹窗用：枚举屏幕/窗口来源（含缩略图，data URL 直接给 <img>）
  ipcMain.handle('ffgui:getDesktopSources', async () => {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 384, height: 216 },
    });
    return sources.map((s) => ({
      id: s.id,
      name: s.name,
      thumb: s.thumbnail.isEmpty() ? '' : s.thumbnail.toDataURL(),
    }));
  });

  // 渲染进程选定来源后、调用 getDisplayMedia 前登记 id，授权 handler 按此授予
  ipcMain.handle('ffgui:prepareDesktopSource', (_event, id) => {
    pendingDesktopSourceId = typeof id === 'string' ? id : null;
    return true;
  });

  ipcMain.handle('ffgui:cancelConvert', () => {
    cancelCurrentTask();
  });
}

// getFfmpegPath 一并导出：main/cdrip.js 与 main/dub.js 都要自行 spawn ffmpeg
// （修复：此前只导出上面四个，require 侧拿到 undefined，抓轨/配音会 spawn 失败）
module.exports = {
  registerIpc,
  getCapabilities,
  runSingleFileConversion,
  cancelCurrentTask,
  getFfmpegPath,
};
