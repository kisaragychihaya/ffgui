'use strict';

// 字幕配音（dub）主进程模块。
//
// 流程：读取字幕文件 -> 本地 TTS 引擎（native/qwentts.cpp 的 tts-server，
// OpenAI 兼容 HTTP）逐条合成 24kHz 单声道 WAV -> 按字幕时间轴拼成一条与视频
// 等长的 48kHz 单声道音轨 -> 与视频混流为额外一条音轨。
//
// 引擎事实（依据 submodule native/qwentts.cpp 的 tools/tts-server.cpp 与
// src/tts-server.h，勿凭印象改动）：
// - CLI：tts-server --model <talker.gguf> --codec <tokenizer.gguf>
//         [--device CUDA0|Vulkan0|CPU] [--alias <id>] [--host <ip>]
//         [--port <n>] [--lang <name>] [--max-batch <n>] [--no-fa]
//         [--clamp-fp16] [--codec-chunk-dur <sec>]
// - 端点：POST /v1/audio/speech（input 必填；language / voice / instructions /
//   response_format "wav"|"pcm" / seed 与采样覆盖；"wav" 返回一次性 RIFF，
//   采样率 24kHz、s16 单声道）、GET /health（{"status":"ok"} 存活探针）、
//   GET /v1/models、GET|POST /v1/audio/voices、DELETE /v1/audio/voices/{name}
// - 语言：--lang / body 里的 language 取上游 config.json 的 codec_language_id
//   键名（GGUF 中存为 qwen3-tts.codec.language_names），引擎按小写不敏感匹配，
//   auto 表示不指定语言 id。1.7b base 的十个语言见 LANGUAGES。
//
// 与 main/cdrip.js 一样自行 spawn ffmpeg（不复用 main/ffmpeg.js 的
// runFfmpegTask），因为需要按阶段换算进度并支持取消。

const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const { t } = require('./i18n');
const { getFfmpegPath } = require('./ffmpeg');

const EVENT_CHANNEL = 'ffgui:dub-event';
const PARTIAL_SUFFIX = '.ffgui-partial';

// ---------- 引擎与模型 ----------

const ENGINE_ALIAS = 'ffgui-dub';
const ENGINE_HOST = '127.0.0.1';
const ENGINE_HEALTH_TIMEOUT_MS = 30000;
const ENGINE_HEALTH_INTERVAL_MS = 300;
// 单条字幕的合成超时：TTS 在 CPU 上可能比实时慢得多，给足 5 分钟
const SPEECH_TIMEOUT_MS = 300000;

const MODEL_VARIANTS = ['Q4_K_M', 'Q8_0'];
const DEFAULT_VARIANT_ORDER = ['Q8_0', 'Q4_K_M'];
const MODEL_BASE_HOSTS = {
  official: 'https://huggingface.co',
  mirror: 'https://hf-mirror.com',
};
const MODEL_REPO = 'Serveurperso/Qwen3-TTS-GGUF';
const USER_AGENT = 'FFGui/1.0 (https://github.com/kisaragychihaya/ffgui)';

// 模型文件名：v1 固定 talker 1.7b base 模式 + 与 variant 匹配的 tokenizer
function talkerFileName(variant) {
  return `qwen-talker-1.7b-base-${variant}.gguf`;
}

function tokenizerFileName(variant) {
  return `qwen-tokenizer-12hz-${variant}.gguf`;
}

// 下载地址：official 走 huggingface.co，mirror 换成 hf-mirror.com（国内镜像）
function modelDownloadUrl(file, mirror = 'official') {
  const host = MODEL_BASE_HOSTS[mirror === 'mirror' ? 'mirror' : 'official'];
  return `${host}/${MODEL_REPO}/resolve/main/${file}`;
}

// 引擎能识别的语言（大写开头的名字来自上游 config.json，见文件头注释）。
// auto = 不指定语言 id，由模型从文本推断。
const LANGUAGES = [
  'auto',
  'chinese',
  'english',
  'german',
  'italian',
  'portuguese',
  'spanish',
  'japanese',
  'korean',
  'french',
  'russian',
].map((id) => ({ id, dictKey: `dub.lang.${id}` }));

const LANGUAGE_IDS = new Set(LANGUAGES.map((entry) => entry.id));

// 音轨语言元数据用的 BCP 47 码（容器层面，与引擎的 --lang 名字是两套）
const BCP47 = {
  auto: 'und',
  chinese: 'zh',
  english: 'en',
  german: 'de',
  italian: 'it',
  portuguese: 'pt',
  spanish: 'es',
  japanese: 'ja',
  korean: 'ko',
  french: 'fr',
  russian: 'ru',
};

function languageToBcp47(language) {
  return BCP47[String(language || '').toLowerCase()] || 'und';
}

// MP4/MOV 的 mov muxer 只认 ISO 639-2 三字母码（"zh" 会被静默丢弃，实测），
// MKV 等容器用 BCP 47 两字母码。两套码由容器决定，任务里传的仍是语言 id。
const ISO639_2 = {
  und: 'und',
  zh: 'zho',
  en: 'eng',
  de: 'deu',
  it: 'ita',
  pt: 'por',
  es: 'spa',
  ja: 'jpn',
  ko: 'kor',
  fr: 'fra',
  ru: 'rus',
};

function containerLanguageTag(language, ext) {
  const bcp47 = languageToBcp47(language);
  const kind = String(ext || '').toLowerCase().replace(/^\./, '');
  if (kind === 'mp4' || kind === 'm4v' || kind === 'mov') return ISO639_2[bcp47] || 'und';
  return bcp47;
}

// ---------- 字幕 ----------

const SUBTITLE_EXTS = new Set(['srt', 'vtt', 'ass', 'ssa']);
const MAX_CUES = 1000;
const MAX_CUE_CHARS = 500;

// ---------- 错误 ----------

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function dubError(code, message, params = {}) {
  const err = new Error(message);
  err.code = code;
  err.params = params;
  return err;
}

function invalid(field, message) {
  return dubError('FFGUI_DUB_INVALID_JOB', message, { field });
}

function requiredString(value, field) {
  if (typeof value !== 'string' || !value) {
    throw invalid(field, t('main.dub.errRequired', { field }));
  }
  return value;
}

// ---------- 纯函数：引擎路径 ----------

// tts-server 位置：
// - 环境变量 FFGUI_TTS_SERVER 优先（测试 / 自定义安装）
// - Windows：打包后 resources/tts/tts-server.exe，开发时 <app>/bin/tts/
// - macOS：bin/tts/ 或 resources/tts/ 的 tts-server
// - Linux：捆绑路径存在则用，否则裸名走 PATH
function getTtsServerPath(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const app = options.app;
  const override = env.FFGUI_TTS_SERVER;
  if (override) return override;

  const packaged = Boolean(app && app.isPackaged);
  const appRoot = app && typeof app.getAppPath === 'function' ? app.getAppPath() : '';
  const resourceRoot = (app && app.isPackaged && process.resourcesPath) ? process.resourcesPath : '';
  const candidates = [];
  if (platform === 'win32') {
    if (packaged && resourceRoot) candidates.push(path.join(resourceRoot, 'tts', 'tts-server.exe'));
    if (appRoot) candidates.push(path.join(appRoot, 'bin', 'tts', 'tts-server.exe'));
  } else if (platform === 'darwin') {
    if (appRoot) candidates.push(path.join(appRoot, 'bin', 'tts', 'tts-server'));
    if (resourceRoot) candidates.push(path.join(resourceRoot, 'tts', 'tts-server'));
  } else {
    if (appRoot) candidates.push(path.join(appRoot, 'bin', 'tts', 'tts-server'));
    if (resourceRoot) candidates.push(path.join(resourceRoot, 'tts', 'tts-server'));
  }
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // 权限等原因无法探测，继续尝试下一个候选
    }
  }
  // Linux 允许走系统 PATH；Windows/macOS 无捆绑即视为缺失
  return platform === 'linux' ? 'tts-server' : null;
}

function enginePresent(enginePath) {
  if (!enginePath) return false;
  // 裸名（Linux PATH）无法静态判定，视为存在，由启动失败给出原因
  if (!enginePath.includes(path.sep) && !path.isAbsolute(enginePath)) return true;
  try {
    return fs.statSync(enginePath).isFile();
  } catch {
    return false;
  }
}

// ---------- 纯函数：字幕解析 ----------

function padFraction(frac) {
  return (String(frac || '0') + '000').slice(0, 3);
}

// 时间戳通用解析：支持 HH:MM:SS,mmm / MM:SS.mmm / H:MM:SS.cc（分秒均可带逗号或点）。
// 小数位按「十进制小数」右补零（"1,5" = 500ms，"00:00:01.12" = 120ms）。
const TIMING_RE = /(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})/g;

function parseTimestamp(raw) {
  const m = String(raw || '').match(/^(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/);
  if (!m) return null;
  const hours = m[1] ? Number(m[1]) : 0;
  return ((hours * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Number(padFraction(m[4]));
}

// 时间轴行：start --> end，结束时间后可跟坐标等尾巴（srt 允许）
function parseTimingLine(line) {
  const m = String(line || '').match(
    /(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})\s*-->\s*(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})/,
  );
  if (!m) return null;
  const startMs = ((m[1] ? Number(m[1]) : 0) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000
    + Number(padFraction(m[4]));
  const endMs = ((m[5] ? Number(m[5]) : 0) * 3600 + Number(m[6]) * 60 + Number(m[7])) * 1000
    + Number(padFraction(m[8]));
  return { startMs, endMs };
}

// 正文清洗：剥 <...> 标签（<i> <font color=...> <v Speaker> 等）、折叠空白。
// 标签按空串处理（<i>中文</i>字幕 不应被拆成「中文 字幕」），仅换行标签留空格。
function cleanCueText(raw) {
  return String(raw || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitBlocks(source) {
  const blocks = [];
  let current = [];
  for (const line of String(source || '').split('\n')) {
    if (line.trim() === '') {
      if (current.length) blocks.push(current);
      current = [];
      continue;
    }
    current.push(line);
  }
  if (current.length) blocks.push(current);
  return blocks;
}

function parseSrtBlocks(source) {
  const cues = [];
  for (const block of splitBlocks(source)) {
    // 序号行可有可无，以含 "-->" 的行为准
    const timingIdx = block.findIndex((line) => line.includes('-->'));
    if (timingIdx < 0) continue;
    const timing = parseTimingLine(block[timingIdx]);
    if (!timing) continue;
    cues.push({
      startMs: timing.startMs,
      endMs: timing.endMs,
      text: block.slice(timingIdx + 1).join(' '),
    });
  }
  return cues;
}

function parseVttBlocks(source) {
  const cues = [];
  for (const block of splitBlocks(source)) {
    const head = String(block[0] || '').trim();
    // WEBVTT 头（可能带 Kind:/Language: 描述行）与 NOTE / STYLE / REGION 块
    if (/^WEBVTT/i.test(head)) continue;
    if (/^(NOTE|STYLE|REGION)\b/i.test(head)) continue;
    const timingIdx = block.findIndex((line) => line.includes('-->'));
    if (timingIdx < 0) continue;
    const timing = parseTimingLine(block[timingIdx]);
    if (!timing) continue;
    cues.push({
      startMs: timing.startMs,
      endMs: timing.endMs,
      text: block.slice(timingIdx + 1).join(' '),
    });
  }
  return cues;
}

// ASS/SSA 的 Dialogue 行按 Format: 声明的列顺序切分（Text 恒为最后一列，
// 故多余逗号并回文本）
function splitAssFields(payload, count) {
  const parts = String(payload || '').split(',');
  if (count <= 0 || parts.length <= count) return parts.map((part) => part.trim());
  const head = parts.slice(0, count - 1).map((part) => part.trim());
  return [...head, parts.slice(count - 1).join(',')];
}

function parseAssBlocks(source) {
  const cues = [];
  let inEvents = false;
  let columns = null;
  for (const raw of String(source || '').split('\n')) {
    const line = raw.trim();
    const section = line.match(/^\[(.+)\]$/);
    if (section) {
      inEvents = section[1].toLowerCase() === 'events';
      columns = null;
      continue;
    }
    if (!inEvents) continue;
    if (/^Format\s*:/i.test(line)) {
      columns = line.slice(line.indexOf(':') + 1).split(',').map((name) => name.trim().toLowerCase());
      continue;
    }
    const event = line.match(/^(Dialogue|Comment)\s*:\s*(.*)$/i);
    if (!event) continue;
    // Comment: 行不是台词，跳过
    if (event[1].toLowerCase() === 'comment') continue;
    if (!columns) continue;
    const startIdx = columns.indexOf('start');
    const endIdx = columns.indexOf('end');
    const textIdx = columns.indexOf('text');
    if (startIdx < 0 || endIdx < 0 || textIdx < 0) continue;
    const fields = splitAssFields(event[2], columns.length);
    const startMs = parseTimestamp(fields[startIdx]);
    const endMs = parseTimestamp(fields[endIdx]);
    if (startMs === null || endMs === null) continue;
    const text = String(fields[textIdx] || '')
      .replace(/\{[^}]*\}/g, '') // 剥 {\pos(...)\b1} 之类的覆盖块（空串，避免把中文拆开）
      .replace(/\\[Nn]/g, ' '); // \N / \n 硬换行
    cues.push({ startMs, endMs, text });
  }
  return cues;
}

// 解析字幕文本为 [{index, startMs, endMs, text}]。
// 顺序：按 startMs 排序；丢弃空文本与非正时长；单条截 500 字符；总数上限 1000。
function parseSubtitleCues(text, ext) {
  const kind = String(ext || '').toLowerCase().replace(/^\./, '');
  if (!SUBTITLE_EXTS.has(kind)) {
    throw dubError('FFGUI_DUB_SUBTITLE_FORMAT',
      t('main.dub.errSubtitleFormat', { ext: kind || '?' }), { ext: kind });
  }
  const source = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const parsed = kind === 'srt'
    ? parseSrtBlocks(source)
    : kind === 'vtt'
      ? parseVttBlocks(source)
      : parseAssBlocks(source);

  const cleaned = parsed
    .map((cue) => ({
      startMs: cue.startMs,
      endMs: cue.endMs,
      text: cleanCueText(cue.text).slice(0, MAX_CUE_CHARS).trim(),
    }))
    .filter((cue) => cue.text !== ''
      && Number.isFinite(cue.startMs) && Number.isFinite(cue.endMs) && cue.endMs > cue.startMs)
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

  if (cleaned.length > MAX_CUES) {
    throw dubError('FFGUI_DUB_TOO_MANY_CUES',
      t('main.dub.errTooManyCues', { count: MAX_CUES }), { count: cleaned.length, limit: MAX_CUES });
  }
  return cleaned.map((cue, i) => ({
    index: i + 1,
    startMs: Math.round(cue.startMs),
    endMs: Math.round(cue.endMs),
    text: cue.text,
  }));
}

// ---------- 纯函数：ffmpeg 参数 ----------

// amix 的输入数上限：超过后分组拼接（FFmpeg 对超大输入数的 amix 会显著变慢）
const MAX_AMIX_INPUTS = 100;

function secondsArg(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return '0';
  return String(Number(num.toFixed(3)));
}

// 组装音轨：每条字幕 WAV 按 startMs 延迟后叠加成一条与视频等长的 48kHz 单声道
// pcm_s16le WAV。超过 100 条时按 100 条一组 amix，组间用 apad 补齐到「下一组
// 起点」再 concat（各组的音频都从 0 秒开始铺，故必须按时间切片后再拼）。
function buildDubAssemblyArgs({ wavEntries, durationMs, outPath } = {}) {
  const entries = Array.isArray(wavEntries) ? wavEntries.filter(isPlainObject) : [];
  const durationSec = Number(durationMs) / 1000;
  if (entries.length === 0) {
    throw dubError('FFGUI_DUB_INVALID_JOB', t('main.dub.errNoCues'));
  }
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw dubError('FFGUI_DUB_INVALID_JOB', t('main.dub.errDuration'));
  }
  if (typeof outPath !== 'string' || !outPath) {
    throw dubError('FFGUI_DUB_INVALID_JOB', t('main.dub.errOutput'));
  }

  const groups = [];
  for (let i = 0; i < entries.length; i += MAX_AMIX_INPUTS) {
    groups.push(entries.slice(i, i + MAX_AMIX_INPUTS));
  }

  const filters = [];
  entries.forEach((entry, i) => {
    const delay = Math.max(0, Math.round(Number(entry.startMs) || 0));
    filters.push(`[${i}:a]adelay=${delay}|all[cue${i}]`);
  });

  const groupLabels = [];
  groups.forEach((group, gi) => {
    const baseIndex = gi * MAX_AMIX_INPUTS;
    const inputs = group.map((_, k) => `[cue${baseIndex + k}]`).join('');
    filters.push(`${inputs}amix=inputs=${group.length}:normalize=0:dropout_transition=0[mix${gi}]`);
    const sliceStartSec = gi === 0 ? 0 : Math.round(Number(group[0].startMs) || 0) / 1000;
    let sliceEndMs = gi === groups.length - 1
      ? Math.round(durationSec * 1000)
      : Math.round(Number(groups[gi + 1][0].startMs) || 0);
    // 同一时刻的条目可能让切片长度为 0，concat 不接受空段，至少留 1ms
    if (sliceEndMs <= sliceStartSec * 1000) sliceEndMs = sliceStartSec * 1000 + 1;
    const sliceLenSec = (sliceEndMs - sliceStartSec * 1000) / 1000;
    filters.push(`[mix${gi}]aformat=sample_rates=48000:sample_fmts=fltp:channel_layouts=mono,`
      + `atrim=start=${secondsArg(sliceStartSec)}:end=${secondsArg(sliceEndMs / 1000)},`
      + `asetpts=PTS-STARTPTS,apad=whole_dur=${secondsArg(sliceLenSec)}[grp${gi}]`);
    groupLabels.push(`[grp${gi}]`);
  });

  let joinedLabel = '[grp0]';
  if (groups.length > 1) {
    filters.push(`${groupLabels.join('')}concat=n=${groups.length}:v=0:a=1[joined]`);
    joinedLabel = '[joined]';
  }
  filters.push(`${joinedLabel}atrim=start=0:end=${secondsArg(durationSec)},asetpts=PTS-STARTPTS[dubout]`);

  const args = ['-hide_banner'];
  for (const entry of entries) args.push('-i', String(entry.path));
  args.push(
    '-filter_complex', filters.join(';'),
    '-map', '[dubout]',
    '-c:a', 'pcm_s16le',
    '-ar', '48000',
    '-ac', '1',
    // 只传 -n（与 -y 互斥），输出路径由主进程预分配
    '-n',
    '-nostats',
    '-progress', 'pipe:1',
    outPath,
  );
  return args;
}

// 混流：保留源全部流（-map 0），把组装好的音轨作为最后一条音频流加入。
// 新音轨序号 = 源音频流数量；MP4 字幕转 mov_text，MKV 原样复制。
function buildDubMuxArgs({
  video,
  audioWav,
  outPath,
  sourceAudioCount = 0,
  keepSubtitle = true,
  language = 'auto',
  title,
} = {}) {
  if (typeof video !== 'string' || !video) {
    throw dubError('FFGUI_DUB_INVALID_JOB', t('main.dub.errRequired', { field: 'video' }));
  }
  if (typeof audioWav !== 'string' || !audioWav) {
    throw dubError('FFGUI_DUB_INVALID_JOB', t('main.dub.errRequired', { field: 'audioWav' }));
  }
  if (typeof outPath !== 'string' || !outPath) {
    throw dubError('FFGUI_DUB_INVALID_JOB', t('main.dub.errOutput'));
  }
  const index = Math.max(0, Math.trunc(Number(sourceAudioCount) || 0));
  const ext = path.extname(outPath).toLowerCase().replace(/^\./, '');
  const args = [
    '-hide_banner',
    '-i', video,
    '-i', audioWav,
    // 源全部流（含字幕/附件）与新配音音轨
    '-map', '0',
    '-map', '1:a:0',
    '-c', 'copy',
    `-c:a:${index}`, 'aac',
    `-b:a:${index}`, '192k',
    '-ar', '48000',
    '-ac', '2',
    `-metadata:s:a:${index}`, `language=${containerLanguageTag(language, ext)}`,
    `-metadata:s:a:${index}`, `title=${title || t('main.dub.trackTitle')}`,
  ];
  if (!keepSubtitle) {
    args.push('-sn');
  } else if (ext === 'mp4' || ext === 'm4v' || ext === 'mov') {
    // MP4 系列不能装 SRT/ASS 原样，转 mov_text
    args.push('-c:s', 'mov_text');
  } else {
    args.push('-c:s', 'copy');
  }
  args.push('-n', '-nostats', '-progress', 'pipe:1', outPath);
  return args;
}

// 容器与扩展名：'same' 时源是 mp4/mkv 沿用，其余一律 mp4
function resolveContainerExt(container, videoPath) {
  const sourceExt = path.extname(String(videoPath || '')).toLowerCase().replace(/^\./, '');
  if (container === 'mp4') return 'mp4';
  if (container === 'mkv') return 'mkv';
  if (sourceExt === 'mp4' || sourceExt === 'mkv') return sourceExt;
  return 'mp4';
}

function pathKey(file) {
  const resolved = path.resolve(file);
  return process.platform === 'linux' ? resolved : resolved.toLowerCase();
}

// 输出路径：与源同目录 <base>_dub.<ext>，撞名加 _2、_3…，并避开已有文件与输入
function uniqueOutputPath(candidate, reserved, fsImpl) {
  const ext = path.extname(candidate);
  const stem = candidate.slice(0, candidate.length - ext.length);
  let out = candidate;
  let suffix = 2;
  while (fsImpl.existsSync(out) || reserved.has(pathKey(out))) out = `${stem}_${suffix++}${ext}`;
  reserved.add(pathKey(out));
  return out;
}

// 统计 ffmpeg -i 输出里各类型流的数量。流标识有三种常见形态：
//   Stream #0:1[0x2](und): Audio: aac ...   （MP4/MOV，带 track id）
//   Stream #0:1(eng): Audio: ac3 ...        （MKV）
//   Stream #0:1: Audio: pcm_s16le ...       （WAV/TS）
// 必须逐行判定类型：单一大正则会被 track id 打断，把带音轨的 MP4 算成 0 条音频。
function countStreams(text) {
  let audioCount = 0;
  let videoCount = 0;
  let subtitleCount = 0;
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!/Stream #\d+:\d+/.test(line)) continue;
    const type = line.match(/:\s*(Video|Audio|Subtitle|Data|Attachment):/);
    if (!type) continue;
    if (type[1] === 'Audio') audioCount += 1;
    // 内嵌封面（attached pic）在 ffmpeg 眼里也是视频流，但不是画面
    else if (type[1] === 'Video' && !/attached pic/i.test(line)) videoCount += 1;
    else if (type[1] === 'Subtitle') subtitleCount += 1;
  }
  return { audioCount, videoCount, subtitleCount };
}

// ---------- 纯函数：任务校验 ----------

const BACKENDS = new Set(['auto', 'vulkan', 'cpu']);
const CONTAINERS = new Set(['same', 'mp4', 'mkv']);

function sanitizeJobId(value) {
  const id = String(value || '').trim();
  // 缓存目录名直接用 jobId，禁止路径分隔符与 ..
  if (!/^[\w.-]{1,64}$/.test(id) || id === '.' || id === '..') {
    throw invalid('id', t('main.dub.errJobId'));
  }
  return id;
}

function validateDubJob(job) {
  if (!isPlainObject(job)) throw invalid('job', t('main.dub.errJobObject'));
  const normalized = {
    id: sanitizeJobId(requiredString(job.id, 'id')),
    video: requiredString(job.video, 'video'),
    subtitle: requiredString(job.subtitle, 'subtitle'),
    language: 'auto',
    backend: 'auto',
    container: 'same',
    variant: '',
  };
  if (job.language !== undefined && job.language !== null && job.language !== '') {
    const language = String(job.language).toLowerCase();
    if (!LANGUAGE_IDS.has(language)) {
      throw invalid('language', t('main.dub.errLanguage', { language: String(job.language) }));
    }
    normalized.language = language;
  }
  if (job.backend !== undefined && job.backend !== null && job.backend !== '') {
    if (!BACKENDS.has(job.backend)) {
      throw invalid('backend', t('main.dub.errBackend', { backend: String(job.backend) }));
    }
    normalized.backend = job.backend;
  }
  if (job.container !== undefined && job.container !== null && job.container !== '') {
    if (!CONTAINERS.has(job.container)) {
      throw invalid('container', t('main.dub.errContainer', { container: String(job.container) }));
    }
    normalized.container = job.container;
  }
  if (job.variant !== undefined && job.variant !== null && job.variant !== '') {
    const variant = String(job.variant).toUpperCase();
    if (!MODEL_VARIANTS.includes(variant)) {
      throw invalid('variant', t('main.dub.errVariant', { variant: String(job.variant) }));
    }
    normalized.variant = variant;
  }
  return normalized;
}

// ---------- 引擎环境变量 ----------

// backend：GGML_BACKEND 由动态加载构建（buildall）识别；auto 不设置，交给引擎自选
function backendEnv(backend, baseEnv) {
  const env = { ...(baseEnv || process.env) };
  if (backend === 'vulkan') env.GGML_BACKEND = 'Vulkan0';
  else if (backend === 'cpu') env.GGML_BACKEND = 'CPU';
  else delete env.GGML_BACKEND;
  return env;
}

// ---------- 服务 ----------

function createDubService(options = {}) {
  const fsImpl = options.fs || fs;
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const spawnImpl = options.spawn || spawn;
  const httpImpl = options.http || require('http');
  const httpsImpl = options.https || require('https');
  const app = options.app;
  const userDataDir = typeof options.userDataDir === 'string' && options.userDataDir
    ? options.userDataDir
    : (app && typeof app.getPath === 'function' ? app.getPath('userData') : '');

  const modelsDir = userDataDir ? path.join(userDataDir, 'tts-models') : '';
  const cacheRoot = userDataDir ? path.join(userDataDir, 'dub-cache') : '';

  const engine = {
    child: null,
    port: 0,
    backend: 'auto',
    ready: false,
    exited: false,
    version: null,
    stderrTail: '',
    binPath: null,
  };
  let activeJob = null;
  let downloadState = null;

  function emitTo(sender, event) {
    if (!sender) return;
    if (typeof sender.isDestroyed === 'function' && sender.isDestroyed()) return;
    try {
      sender.send(EVENT_CHANNEL, event);
    } catch {
      // 窗口关闭不应打断任务
    }
  }

  // ---------- 模型与引擎路径 ----------

  function resolveEnginePath() {
    return getTtsServerPath({ env, platform, app });
  }

  function modelPaths(variant) {
    return {
      talker: path.join(modelsDir, talkerFileName(variant)),
      tokenizer: path.join(modelsDir, tokenizerFileName(variant)),
    };
  }

  function fileInfo(file) {
    try {
      const stat = fsImpl.statSync(file);
      return stat.isFile() ? { present: true, bytes: stat.size } : { present: false, bytes: 0 };
    } catch {
      return { present: false, bytes: 0 };
    }
  }

  // 已下载的模型变体：优先 job 指定的，其次按 Q8_0 → Q4_K_M 探测
  function resolveVariant(requested) {
    const order = requested ? [requested] : DEFAULT_VARIANT_ORDER;
    for (const variant of order) {
      const paths = modelPaths(variant);
      if (fileInfo(paths.talker).present && fileInfo(paths.tokenizer).present) {
        return { variant, ...paths };
      }
    }
    return null;
  }

  // ---------- 引擎进程 ----------

  function findFreePort() {
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.unref();
      server.on('error', reject);
      server.listen(0, ENGINE_HOST, () => {
        const address = server.address();
        const port = address && typeof address === 'object' ? address.port : 0;
        server.close(() => resolve(port));
      });
    });
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function httpRequest({ port, pathName, method = 'GET', body, signal, timeoutMs = 5000 }) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? null : Buffer.from(body, 'utf8');
      const req = httpImpl.request({
        host: ENGINE_HOST,
        port,
        path: pathName,
        method,
        signal,
        timeout: timeoutMs,
        headers: payload
          ? {
            'Content-Type': 'application/json',
            'Content-Length': payload.length,
            Accept: 'audio/wav',
          }
          : { Accept: 'application/json' },
      }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({
          status: res.statusCode || 0,
          body: Buffer.concat(chunks),
        }));
        res.on('error', reject);
      });
      req.on('timeout', () => {
        req.destroy(dubError('FFGUI_DUB_TIMEOUT', t('main.dub.errEngineTimeout')));
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  function isAbortError(err) {
    return Boolean(err) && (err.name === 'AbortError' || err.code === 'ABORT_ERR');
  }

  function stopEngine() {
    const child = engine.child;
    engine.child = null;
    engine.ready = false;
    engine.port = 0;
    engine.version = null;
    if (!child) return;
    try {
      child.kill();
    } catch {
      // 进程可能已退出
    }
  }

  async function waitForHealthy(port, shouldStop) {
    const deadline = Date.now() + ENGINE_HEALTH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (shouldStop && shouldStop()) return false;
      if (engine.exited) return false;
      try {
        const res = await httpRequest({ port, pathName: '/health', timeoutMs: 2000 });
        if (res.status === 200) return true;
      } catch {
        // 还没起来，继续轮询
      }
      await sleep(ENGINE_HEALTH_INTERVAL_MS);
    }
    return false;
  }

  async function ensureEngine(backend, shouldStop) {
    const binPath = resolveEnginePath();
    if (!enginePresent(binPath)) {
      throw dubError('FFGUI_DUB_NO_ENGINE', t('main.dub.errNoEngine'), { path: binPath || '' });
    }
    if (engine.child && engine.ready && !engine.exited) {
      if (engine.backend === backend) return engine;
      // 后端变了必须重启（GGML_BACKEND 只在启动时读）
      stopEngine();
    } else if (engine.child) {
      stopEngine();
    }
    // 优先用任务指定的变体；未指定时按 Q8_0 → Q4_K_M 探测已下载的
    const variantInfo = resolveVariant(activeJob ? activeJob.job.variant : null);
    if (!variantInfo) {
      throw dubError('FFGUI_DUB_NO_MODEL', t('main.dub.errNoModel'), { dir: modelsDir });
    }
    const port = await findFreePort();
    if (!port) throw dubError('FFGUI_DUB_ENGINE', t('main.dub.errEnginePort'));
    const args = [
      '--model', variantInfo.talker,
      '--codec', variantInfo.tokenizer,
      '--alias', ENGINE_ALIAS,
      '--host', ENGINE_HOST,
      '--port', String(port),
    ];
    engine.binPath = binPath;
    engine.port = port;
    engine.backend = backend;
    engine.ready = false;
    engine.exited = false;
    engine.version = null;
    engine.stderrTail = '';
    let child;
    try {
      child = spawnImpl(binPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: backendEnv(backend, env),
      });
    } catch (err) {
      throw dubError('FFGUI_DUB_ENGINE', t('main.dub.errEngineSpawn', {
        reason: err && err.message ? err.message : String(err),
      }));
    }
    engine.child = child;
    const onStderr = (chunk) => {
      const text = chunk.toString();
      engine.stderrTail = (engine.stderrTail + text).slice(-4000);
    };
    if (child.stderr && typeof child.stderr.on === 'function') child.stderr.on('data', onStderr);
    if (child.stdout && typeof child.stdout.on === 'function') child.stdout.on('data', () => {});
    child.on('exit', (code, signal) => {
      engine.exited = true;
      engine.ready = false;
      if (engine.child === child) engine.child = null;
      console.log(`[ffgui] tts-server 退出 code=${code} signal=${signal}`);
      if (activeJob && !activeJob.cancelRequested) activeJob.engineExited = true;
    });
    child.on('error', (err) => {
      engine.exited = true;
      engine.ready = false;
      if (activeJob) activeJob.engineExited = true;
      console.log(`[ffgui] tts-server 启动失败: ${err && err.message ? err.message : err}`);
    });

    const healthy = await waitForHealthy(port, shouldStop);
    if (!healthy) {
      const tail = engine.stderrTail.split(/\r?\n/).filter(Boolean).slice(-5).join('\n');
      stopEngine();
      throw dubError('FFGUI_DUB_ENGINE',
        `${t('main.dub.errEngineStart')}\n${tail}`, { tail });
    }
    engine.ready = true;
    // /v1/models 报告的 model id 即 --alias，用来在界面上显示引擎版本
    try {
      const res = await httpRequest({ port, pathName: '/v1/models', timeoutMs: 3000 });
      if (res.status === 200) {
        const data = JSON.parse(res.body.toString('utf8'));
        const first = Array.isArray(data.data) ? data.data[0] : null;
        engine.version = first && first.id ? String(first.id) : null;
      }
    } catch {
      // 版本只是展示信息，取不到不影响合成
    }
    console.log(`[ffgui] tts-server 就绪：port=${port} backend=${backend}`);
    return engine;
  }

  // ---------- 合成 ----------

  async function synthesizeCues({ state, cues, cacheDir, emit }) {
    const total = cues.length;
    const files = [];
    for (let i = 0; i < cues.length; i += 1) {
      if (state.cancelRequested) return { cancelled: true, files };
      const cue = cues[i];
      const index = i + 1;
      emit({ jobId: state.id, type: 'cue-start', index, total });
      const body = JSON.stringify({
        input: cue.text,
        language: state.job.language,
        response_format: 'wav',
      });
      let res;
      try {
        res = await httpRequest({
          port: engine.port,
          pathName: '/v1/audio/speech',
          method: 'POST',
          body,
          signal: state.abort.signal,
          timeoutMs: SPEECH_TIMEOUT_MS,
        });
      } catch (err) {
        if (state.cancelRequested || isAbortError(err)) return { cancelled: true, files };
        if (state.engineExited) {
          throw dubError('FFGUI_DUB_ENGINE_EXIT', t('main.dub.errEngineExit'));
        }
        throw dubError('FFGUI_DUB_SYNTH', t('main.dub.errSynthesize', {
          index,
          reason: err && err.message ? err.message : String(err),
        }));
      }
      if (state.cancelRequested) return { cancelled: true, files };
      if (res.status !== 200) {
        throw dubError('FFGUI_DUB_SYNTH', t('main.dub.errSynthesize', {
          index,
          reason: speechErrorMessage(res),
        }), { index, status: res.status });
      }
      // 引擎返回一次性 RIFF（24kHz s16 单声道），校验魔数防止把错误页当音频
      if (res.body.length < 44 || res.body.toString('latin1', 0, 4) !== 'RIFF') {
        throw dubError('FFGUI_DUB_SYNTH', t('main.dub.errSynthesize', {
          index,
          reason: t('main.dub.errAudioInvalid'),
        }), { index });
      }
      const target = path.join(cacheDir, `cue_${String(index).padStart(4, '0')}.wav`);
      fsImpl.writeFileSync(target, res.body);
      files.push({ path: target, startMs: cue.startMs });
      emit({ jobId: state.id, type: 'cue-done', index, total });
      emit({
        jobId: state.id,
        type: 'progress',
        phase: 'synthesize',
        percent: Math.round((index / total) * 100),
      });
    }
    return { cancelled: false, files };
  }

  function speechErrorMessage(res) {
    try {
      const data = JSON.parse(res.body.toString('utf8'));
      const message = data && data.error && data.error.message;
      if (typeof message === 'string' && message) return message.slice(0, 300);
    } catch {
      // 非 JSON 错误体，退回状态码
    }
    return `HTTP ${res.status}`;
  }

  // ---------- ffmpeg 执行 ----------

  function parseTimeToSeconds(value) {
    const m = String(value || '').match(/(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (!m) return 0;
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  }

  // 自行 spawn ffmpeg：解析 -progress pipe:1，取消时 kill
  function runFfmpegTask({ args, control, durationSec, onProgress, onLog }) {
    return new Promise((resolve) => {
      const bin = getFfmpegPath();
      if (!bin) {
        resolve({ ok: false, cancelled: false, error: t('main.err.ffmpegMissing') });
        return;
      }
      let child;
      try {
        child = spawnImpl(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (err) {
        resolve({ ok: false, cancelled: false, error: err && err.message ? err.message : String(err) });
        return;
      }
      if (control) control.child = child;
      let outBuffer = '';
      let kv = {};
      let stderrTail = '';
      let errLineBuf = '';
      let progressEnded = false;
      let finished = false;

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
          if (val === 'end') progressEnded = true;
          const timeSec = kv.out_time ? parseTimeToSeconds(kv.out_time) : 0;
          const percent = durationSec > 0
            ? Math.min(99, Math.round((timeSec / durationSec) * 100)) : 0;
          if (typeof onProgress === 'function') onProgress(percent);
          kv = {};
        }
      });

      child.stderr.on('data', (chunk) => {
        const text = chunk.toString();
        stderrTail = (stderrTail + text).slice(-4000);
        if (typeof onLog === 'function') onLog(text);
        errLineBuf += text;
        const lines = errLineBuf.split(/\r\n|\r|\n/);
        errLineBuf = lines.pop() || '';
        for (const line of lines) {
          if (line.trim()) console.log(`[ffmpeg] ${line}`);
        }
      });

      child.on('error', (err) => {
        if (finished) return;
        finished = true;
        resolve({ ok: false, cancelled: false, error: err && err.message ? err.message : String(err) });
      });

      child.on('close', (code) => {
        if (finished) return;
        finished = true;
        if (errLineBuf.trim()) console.log(`[ffmpeg] ${errLineBuf.trim()}`);
        if (control && control.cancelled) {
          resolve({ ok: false, cancelled: true });
          return;
        }
        // 部分构建在 -n 拒绝覆盖时仍返回 0，必须同时收到 progress=end
        if (code === 0 && progressEnded) {
          if (typeof onProgress === 'function') onProgress(100);
          resolve({ ok: true });
          return;
        }
        const tail = stderrTail.split(/\r?\n/).filter(Boolean).slice(-5).join('\n');
        const reason = code === 0
          ? t('main.err.ffmpegIncompleteOutput')
          : t('main.err.ffmpegExitCode', { code });
        resolve({ ok: false, cancelled: false, error: `${reason}\n${tail}` });
      });
    });
  }

  // 探测视频：时长与音频流数量（attached pic 封面不算音频流）
  function probeVideo(file) {
    return new Promise((resolve) => {
      const bin = getFfmpegPath();
      if (!bin) {
        resolve({ ok: false, error: t('main.err.ffmpegMissing'), durationMs: 0, audioCount: 0 });
        return;
      }
      let child;
      try {
        child = spawnImpl(bin, ['-hide_banner', '-i', file], { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (err) {
        resolve({
          ok: false,
          error: err && err.message ? err.message : String(err),
          durationMs: 0,
          audioCount: 0,
        });
        return;
      }
      let stderr = '';
      let stdout = '';
      let finished = false;
      child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
      child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
      const done = () => {
        if (finished) return;
        finished = true;
        const text = `${stderr}\n${stdout}`;
        const duration = text.match(/Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/);
        const durationMs = duration
          ? Math.round((Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3])) * 1000)
          : 0;
        const { audioCount, videoCount } = countStreams(text);
        if (videoCount === 0) {
          resolve({ ok: false, error: t('main.dub.errNoVideoStream'), durationMs: 0, audioCount: 0 });
          return;
        }
        resolve({ ok: true, durationMs, audioCount });
      };
      child.on('error', (err) => {
        if (finished) return;
        finished = true;
        resolve({
          ok: false,
          error: err && err.message ? err.message : String(err),
          durationMs: 0,
          audioCount: 0,
        });
      });
      child.on('close', done);
    });
  }

  // ---------- 状态 ----------

  function languages() {
    return LANGUAGES.map((entry) => ({ ...entry }));
  }

  async function status() {
    const enginePath = resolveEnginePath();
    const present = enginePresent(enginePath);
    let variant = null;
    for (const candidate of DEFAULT_VARIANT_ORDER) {
      const paths = modelPaths(candidate);
      if (fileInfo(paths.talker).present && fileInfo(paths.tokenizer).present) {
        variant = candidate;
        break;
      }
    }
    const current = modelPaths(variant || DEFAULT_VARIANT_ORDER[0]);
    const state = !present ? 'missing-engine' : (variant ? 'ok' : 'no-model');
    return {
      state,
      engine: {
        present,
        running: Boolean(engine.ready && engine.child && !engine.exited),
        version: engine.version || undefined,
        backend: engine.backend,
        path: enginePath || '',
      },
      models: {
        variant: variant || undefined,
        talker: fileInfo(current.talker),
        tokenizer: fileInfo(current.tokenizer),
      },
      downloading: downloadState
        ? {
          file: downloadState.file,
          receivedBytes: downloadState.receivedBytes,
          totalBytes: downloadState.totalBytes,
        }
        : null,
      languages: languages(),
    };
  }

  // ---------- 模型下载 ----------

  // 下载单个文件。失败/中断时先关掉写流再 reject —— Windows 上句柄未关会被
  // 占用，.partial 就删不掉，下次启动会被误当成半截模型。
  function downloadFile({ url, target, onChunk, signal, redirects = 0 }) {
    return new Promise((resolve, reject) => {
      if (redirects > 5) {
        reject(dubError('FFGUI_DUB_DOWNLOAD', t('main.dub.errDownloadRedirect')));
        return;
      }
      const isHttps = url.startsWith('https:');
      const mod = isHttps ? httpsImpl : httpImpl;
      let settled = false;
      let res = null;
      let out = null;
      let req = null;

      const fail = (err) => {
        if (settled) return;
        settled = true;
        try {
          if (req) req.destroy();
        } catch {
          // 已销毁
        }
        try {
          if (res) res.resume();
        } catch {
          // 已结束
        }
        if (!out) {
          reject(err);
          return;
        }
        if (out.closed) {
          reject(err);
          return;
        }
        out.once('close', () => reject(err));
        try {
          out.destroy();
        } catch {
          reject(err);
        }
      };

      try {
        req = mod.get(url, {
          signal,
          headers: { 'User-Agent': USER_AGENT, Accept: 'application/octet-stream' },
          timeout: 60000,
        }, (response) => {
          res = response;
          const code = res.statusCode || 0;
          if (code >= 300 && code < 400 && res.headers.location) {
            res.resume();
            if (settled) return;
            settled = true;
            const next = new URL(res.headers.location, url).toString();
            resolve(downloadFile({ url: next, target, onChunk, signal, redirects: redirects + 1 }));
            return;
          }
          if (code !== 200) {
            res.resume();
            fail(dubError('FFGUI_DUB_DOWNLOAD',
              t('main.dub.errDownloadHttp', { status: code }), { status: code }));
            return;
          }
          const totalBytes = Number(res.headers['content-length']) || 0;
          let receivedBytes = 0;
          try {
            out = fsImpl.createWriteStream(target);
          } catch (err) {
            fail(err);
            return;
          }
          out.on('error', fail);
          res.on('error', fail);
          res.on('data', (chunk) => {
            receivedBytes += chunk.length;
            if (typeof onChunk === 'function') onChunk(receivedBytes, totalBytes);
          });
          res.pipe(out);
          out.on('finish', () => {
            if (settled) return;
            settled = true;
            resolve({ bytes: receivedBytes, totalBytes });
          });
        });
      } catch (err) {
        fail(err);
        return;
      }
      if (req && typeof req.on === 'function') {
        req.on('timeout', () => {
          fail(dubError('FFGUI_DUB_DOWNLOAD', t('main.dub.errDownloadTimeout')));
        });
        req.on('error', fail);
      }
      if (signal && typeof signal.addEventListener === 'function') {
        signal.addEventListener('abort', () => fail(
          dubError('FFGUI_DUB_DOWNLOAD', t('main.dub.errDownloadAborted')),
        ), { once: true });
      }
    });
  }

  // 下载一组模型（talker + tokenizer）：先写 .partial，完成后改名
  async function download(sender, variant, mirror) {
    if (downloadState) throw dubError('FFGUI_DUB_BUSY', t('main.dub.errBusyDownload'));
    if (activeJob) throw dubError('FFGUI_DUB_BUSY', t('main.dub.errBusy'));
    const variantName = String(variant || 'Q8_0').toUpperCase();
    if (!MODEL_VARIANTS.includes(variantName)) {
      throw invalid('variant', t('main.dub.errVariant', { variant: String(variant) }));
    }
    const mirrorMode = mirror === 'mirror' ? 'mirror' : 'official';
    const files = [talkerFileName(variantName), tokenizerFileName(variantName)];
    const abort = new AbortController();
    downloadState = {
      variant: variantName,
      file: files[0],
      partial: '',
      receivedBytes: 0,
      totalBytes: 0,
      cancelRequested: false,
      abort,
      sender,
    };
    try {
      fsImpl.mkdirSync(modelsDir, { recursive: true });
      for (const file of files) {
        if (downloadState.cancelRequested) break;
        const target = path.join(modelsDir, file);
        const partial = target + PARTIAL_SUFFIX;
        const url = modelDownloadUrl(file, mirrorMode);
        downloadState.file = file;
        downloadState.partial = partial;
        downloadState.receivedBytes = 0;
        downloadState.totalBytes = 0;
        emitTo(sender, { type: 'download-start', file, variant: variantName, mirror: mirrorMode, url });
        let lastEmit = 0;
        let lastPercent = -1;
        const result = await downloadFile({
          url,
          target: partial,
          signal: abort.signal,
          onChunk: (receivedBytes, totalBytes) => {
            if (downloadState) {
              downloadState.receivedBytes = receivedBytes;
              downloadState.totalBytes = totalBytes;
            }
            const percent = totalBytes > 0 ? Math.floor((receivedBytes / totalBytes) * 100) : 0;
            const now = Date.now();
            // 限流：百分比变化或每 400ms 一次，避免事件洪水
            if (percent === lastPercent && now - lastEmit < 400) return;
            lastPercent = percent;
            lastEmit = now;
            emitTo(sender, {
              type: 'download-progress',
              file,
              receivedBytes,
              totalBytes,
            });
          },
        });
        if (downloadState.cancelRequested) {
          safeUnlink(partial);
          break;
        }
        try {
          fsImpl.renameSync(partial, target);
        } catch (err) {
          safeUnlink(partial);
          throw dubError('FFGUI_DUB_DOWNLOAD', t('main.dub.errDownloadSave', {
            file,
            reason: err && err.message ? err.message : String(err),
          }));
        }
        emitTo(sender, { type: 'download-done', file, bytes: result.bytes });
      }
      if (downloadState.cancelRequested) {
        return { cancelled: true, files: [] };
      }
      return { cancelled: false, files, variant: variantName };
    } catch (err) {
      const file = downloadState ? downloadState.file : files[0];
      // 中断/失败都删掉 .partial，避免留下半截模型被误认为已下载
      if (downloadState && downloadState.partial) safeUnlink(downloadState.partial);
      if (downloadState && downloadState.cancelRequested) {
        return { cancelled: true, files: [] };
      }
      const message = err && err.message ? err.message : String(err);
      emitTo(sender, { type: 'download-error', file, error: message, code: err && err.code });
      throw err;
    } finally {
      downloadState = null;
    }
  }

  function cancelDownload() {
    if (!downloadState) return false;
    downloadState.cancelRequested = true;
    try {
      downloadState.abort.abort();
    } catch {
      // 已中止
    }
    return true;
  }

  function safeUnlink(file) {
    try {
      fsImpl.unlinkSync(file);
    } catch (err) {
      if (err && err.code === 'ENOENT') return;
      console.log(`[ffgui] 删除文件失败: ${file} (${err && err.message ? err.message : err})`);
    }
  }

  // ---------- 字幕文件 ----------

  async function readSubtitle(file) {
    const ext = path.extname(String(file || '')).toLowerCase().replace(/^\./, '');
    if (!SUBTITLE_EXTS.has(ext)) {
      throw dubError('FFGUI_DUB_SUBTITLE_FORMAT',
        t('main.dub.errSubtitleFormat', { ext: ext || '?' }), { ext });
    }
    let text;
    try {
      text = fsImpl.readFileSync(file, 'utf8');
    } catch (err) {
      throw dubError('FFGUI_DUB_SUBTITLE_READ', t('main.dub.errSubtitleRead', {
        path: file,
        reason: err && err.message ? err.message : String(err),
      }), { path: file });
    }
    return parseSubtitleCues(text, ext);
  }

  async function parseSubtitleFile(file) {
    const cues = await readSubtitle(file);
    const durationMs = cues.length ? cues[cues.length - 1].endMs : 0;
    return { cues, durationMs };
  }

  // ---------- 配音任务 ----------

  function cancel(jobId) {
    const state = activeJob;
    if (!state || state.id !== jobId) return false;
    state.cancelRequested = true;
    if (state.control) state.control.cancelled = true;
    try {
      state.abort.abort();
    } catch {
      // 已中止
    }
    if (state.control && state.control.child) {
      try {
        state.control.child.kill();
      } catch {
        // 进程可能已退出
      }
    }
    return true;
  }

  async function start(sender, job) {
    if (activeJob) throw dubError('FFGUI_DUB_BUSY', t('main.dub.errBusy'));
    if (downloadState) throw dubError('FFGUI_DUB_BUSY', t('main.dub.errBusyDownload'));
    const normalized = validateDubJob(job);

    const video = await probeVideo(normalized.video);
    if (!video.ok) {
      throw dubError('FFGUI_DUB_VIDEO', t('main.dub.errVideoProbe', {
        path: normalized.video,
        reason: video.error || '',
      }), { path: normalized.video });
    }
    if (!(video.durationMs > 0)) {
      throw dubError('FFGUI_DUB_VIDEO', t('main.dub.errVideoDuration', { path: normalized.video }));
    }
    // 字幕在主进程重新解析：不信任渲染层传回的条目
    const cues = await readSubtitle(normalized.subtitle);
    if (cues.length === 0) {
      throw dubError('FFGUI_DUB_NO_CUES', t('main.dub.errNoCues'));
    }
    if (!userDataDir) {
      throw dubError('FFGUI_DUB_FAILED', t('main.dub.errNoUserData'));
    }

    const ext = resolveContainerExt(normalized.container, normalized.video);
    const videoPath = path.resolve(normalized.video);
    const base = path.basename(videoPath, path.extname(videoPath));
    const reserved = new Set([pathKey(videoPath), pathKey(path.resolve(normalized.subtitle))]);
    const outPath = uniqueOutputPath(
      path.join(path.dirname(videoPath), `${base}_dub.${ext}`), reserved, fsImpl);

    const state = {
      id: normalized.id,
      job: normalized,
      sender,
      cancelRequested: false,
      control: {},
      abort: new AbortController(),
      engineExited: false,
    };
    activeJob = state;
    const emit = (event) => emitTo(sender, event);
    const cacheDir = path.join(cacheRoot, state.id);
    let completed = false;

    try {
      emit({ jobId: state.id, type: 'start', total: cues.length, output: outPath });
      fsImpl.mkdirSync(cacheDir, { recursive: true });

      emit({ jobId: state.id, type: 'phase', phase: 'synthesize' });
      // 引擎首次加载模型可能很慢（分钟级）；取消时轮询会提前退出，
      // 由下面的 catch 走「取消」而不是报错分支
      await ensureEngine(normalized.backend, () => state.cancelRequested);
      if (state.cancelRequested) {
        emit({ jobId: state.id, type: 'done', output: null, cancelled: true });
        return { output: null, cancelled: true, cues: cues.length };
      }

      const synth = await synthesizeCues({ state, cues, cacheDir, emit });
      if (synth.cancelled || state.cancelRequested) {
        state.cancelRequested = true;
        emit({ jobId: state.id, type: 'done', output: null, cancelled: true });
        return { output: null, cancelled: true, cues: cues.length };
      }
      if (synth.files.length === 0) {
        throw dubError('FFGUI_DUB_NO_CUES', t('main.dub.errNoCues'));
      }

      emit({ jobId: state.id, type: 'phase', phase: 'assemble' });
      const assembledWav = path.join(cacheDir, 'dub.wav');
      const assembleArgs = buildDubAssemblyArgs({
        wavEntries: synth.files,
        durationMs: video.durationMs,
        outPath: assembledWav,
      });
      const assembled = await runFfmpegTask({
        args: assembleArgs,
        control: state.control,
        durationSec: video.durationMs / 1000,
        onProgress: (percent) => emit({
          jobId: state.id, type: 'progress', phase: 'assemble', percent,
        }),
        onLog: (text) => emit({
          jobId: state.id,
          type: 'log',
          level: 'info',
          code: 'DUB_ASSEMBLE',
          message: String(text).trim().slice(0, 500),
        }),
      });
      if (assembled.cancelled || state.cancelRequested) {
        state.cancelRequested = true;
        emit({ jobId: state.id, type: 'done', output: null, cancelled: true });
        return { output: null, cancelled: true, cues: cues.length };
      }
      if (!assembled.ok) {
        throw dubError('FFGUI_DUB_ASSEMBLE', t('main.dub.errAssemble', {
          reason: assembled.error || '',
        }));
      }

      emit({ jobId: state.id, type: 'phase', phase: 'mux' });
      const muxArgs = buildDubMuxArgs({
        video: videoPath,
        audioWav: assembledWav,
        outPath,
        sourceAudioCount: video.audioCount,
        keepSubtitle: true,
        language: normalized.language,
        title: t('main.dub.trackTitle'),
      });
      state.control.child = null;
      const muxed = await runFfmpegTask({
        args: muxArgs,
        control: state.control,
        durationSec: video.durationMs / 1000,
        onProgress: (percent) => emit({
          jobId: state.id, type: 'progress', phase: 'mux', percent,
        }),
        onLog: (text) => emit({
          jobId: state.id,
          type: 'log',
          level: 'info',
          code: 'DUB_MUX',
          message: String(text).trim().slice(0, 500),
        }),
      });
      if (muxed.cancelled || state.cancelRequested) {
        state.cancelRequested = true;
        emit({ jobId: state.id, type: 'done', output: null, cancelled: true });
        return { output: null, cancelled: true, cues: cues.length };
      }
      if (!muxed.ok) {
        throw dubError('FFGUI_DUB_MUX', t('main.dub.errMux', { reason: muxed.error || '' }));
      }

      completed = true;
      emit({ jobId: state.id, type: 'file-done', output: outPath });
      emit({ jobId: state.id, type: 'done', output: outPath, cancelled: false });
      return { output: outPath, cancelled: false, cues: cues.length };
    } catch (err) {
      // 半成品不留给用户：输出是本次新分配的名字，直接删掉
      if (!completed) safeUnlink(outPath);
      const cancelled = state.cancelRequested;
      if (!cancelled) {
        const code = err && typeof err.code === 'string' ? err.code : 'FFGUI_DUB_FAILED';
        const params = err && isPlainObject(err.params)
          ? err.params
          : { message: err && err.message ? err.message : String(err) };
        const message = err && err.message ? err.message : String(err);
        emit({
          jobId: state.id,
          type: 'file-error',
          error: { code, message, params },
        });
      }
      emit({ jobId: state.id, type: 'done', output: null, cancelled });
      return {
        output: null,
        cancelled,
        cues: cues.length,
        error: cancelled ? null : {
          code: err && typeof err.code === 'string' ? err.code : 'FFGUI_DUB_FAILED',
          message: err && err.message ? err.message : String(err),
          params: err && isPlainObject(err.params) ? err.params : {},
        },
      };
    } finally {
      state.control.child = null;
      // 缓存目录（逐条 WAV + 组装音轨）用完即清，取消也清
      try {
        fsImpl.rmSync(cacheDir, { recursive: true, force: true });
      } catch (err) {
        console.log(`[ffgui] 清理配音缓存失败: ${cacheDir} (${err && err.message ? err.message : err})`);
      }
      if (activeJob === state) activeJob = null;
    }
  }

  // 退出时回收常驻引擎
  function dispose() {
    stopEngine();
  }

  return {
    status,
    languages,
    download,
    cancelDownload,
    parseSubtitleFile,
    start,
    cancel,
    dispose,
  };
}

// ---------- IPC 注册 ----------

function registerDubIpc() {
  const electron = require('electron');
  const { ipcMain, dialog, app, BrowserWindow } = electron;
  const { t: translate } = require('./i18n');
  const service = createDubService({ app });

  ipcMain.handle('ffgui:dub-status', () => service.status());
  ipcMain.handle('ffgui:dub-languages', () => service.languages());

  ipcMain.handle('ffgui:dub-download', (event, payload) => {
    const variant = payload && payload.variant;
    const mirror = payload && payload.mirror;
    return service.download(event.sender, variant, mirror);
  });
  ipcMain.handle('ffgui:dub-cancel-download', () => service.cancelDownload());

  ipcMain.handle('ffgui:dub-pick-video', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const res = await dialog.showOpenDialog(win, {
      title: translate('main.dialog.pickVideo'),
      properties: ['openFile'],
      filters: [
        {
          name: translate('main.dialog.filterVideo'),
          extensions: ['mp4', 'mkv', 'mov', 'avi', 'webm', 'flv', 'wmv', 'ts', 'm4v'],
        },
        { name: translate('main.dialog.filterAllFiles'), extensions: ['*'] },
      ],
    });
    return res.canceled ? null : res.filePaths[0];
  });

  ipcMain.handle('ffgui:dub-parse-subtitle', (_event, file) => {
    if (typeof file !== 'string' || !file) {
      throw dubError('FFGUI_DUB_INVALID_JOB', translate('main.dub.errRequired', { field: 'subtitle' }));
    }
    return service.parseSubtitleFile(file);
  });

  ipcMain.handle('ffgui:dub-start', (event, job) => service.start(event.sender, job));
  ipcMain.handle('ffgui:dub-cancel', (_event, jobId) => service.cancel(jobId));

  if (app && typeof app.on === 'function') {
    app.on('will-quit', () => service.dispose());
  }
  return service;
}

module.exports = {
  createDubService,
  registerDubIpc,
  // 纯函数（供渲染层复用与单测）
  parseSubtitleCues,
  buildDubAssemblyArgs,
  buildDubMuxArgs,
  validateDubJob,
  countStreams,
  getTtsServerPath,
  modelDownloadUrl,
  talkerFileName,
  tokenizerFileName,
  languageToBcp47,
  containerLanguageTag,
  resolveContainerExt,
  uniqueOutputPath,
  backendEnv,
  // 常量
  LANGUAGES,
  MODEL_VARIANTS,
  MAX_CUES,
  MAX_CUE_CHARS,
  MAX_AMIX_INPUTS,
  EVENT_CHANNEL,
};
