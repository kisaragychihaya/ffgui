'use strict';

// 字幕配音（dub）主进程模块。
//
// 流程：读取字幕文件 -> 本地 TTS 引擎（native/qwentts.cpp 的 tts-server，
// OpenAI 兼容 HTTP）逐条合成 24kHz 单声道 WAV -> 按字幕时间轴拼成一条与视频
// 等长的 48kHz 单声道音轨 -> 与视频混流。混流有两种输出结构：
// 多轨（默认，mix=false）保留源音轨、追加额外一条配音轨，default
// disposition 让给配音轨（否则播放器仍放原声）；混音（mix=true）把源音轨与配音
// 轨按 -30~+12 dB 的配音音量 amix 成唯一一条音轨，源音轨不再单独存在。
//
// 三步都有自检，宁可报错也不交废成品：单条 WAV 的 RIFF/data 段非空 -> 组装后
// 用 volumedetect 确认整条配音轨不是全静音 -> 混流后回探成品音轨数（多轨 = 源 + 1，
// 混音 = 1）。
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
//   auto 表示不指定语言 id。1.7b customvoice 的十个语言见 LANGUAGES。
// - 音色：用 customvoice 模型，GGUF 的 qwen3-tts.codec.speaker_names 里带十个固定
//   说话人（见 DEFAULT_SPEAKERS）。请求体的 voice 字段按名字选：引擎对已注册的克隆
//   voice 优先，否则 p.speaker = req.voice，customvoice 模式下即该说话人；base 模型
//   没有说话人表，传 voice 会被引擎拒（unknown voice）。
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
// 三个下载源：官方 HF / hf-mirror / ModelScope。前两个是同一份仓库，ModelScope
// 是第三方搬运的镜像仓库（路径带 models/ 前缀、分支 master，且缺 Q4_K_M 的文件）
const MODEL_BASE_HOSTS = {
  official: 'https://huggingface.co',
  hfmirror: 'https://hf-mirror.com',
  modelscope: 'https://modelscope.cn',
};
const MODEL_REPO = 'Serveurperso/Qwen3-TTS-GGUF';
const MODELSCOPE_REPO = 'leletxh/Qwen3-TTS-GGUF';
const MIRROR_MODES = new Set(['official', 'hfmirror', 'modelscope']);
const USER_AGENT = 'FFGui/1.0 (https://github.com/kisaragychihaya/ffgui)';

// aria2c（模型下载优先用它，支持断点续传）：探测超时、取消时的宽限期
const ARIA2_PROBE_TIMEOUT_MS = 5000;
const ARIA2_KILL_GRACE_MS = 3000;

// 模型文件名：v1 固定 talker 1.7b customvoice 模式 + 与 variant 匹配的 tokenizer。
// 用 customvoice 而不用 base：base 模型没有 speaker_names，每条字幕的音色都是随机
// 采样出来的，同一份字幕两次配音听起来像两个人；customvoice 带十个固定说话人
// （DEFAULT_SPEAKERS），音色由请求体的 voice 决定。tokenizer 两个模式共用同一份。
function talkerFileName(variant) {
  return `qwen-talker-1.7b-customvoice-${variant}.gguf`;
}

function tokenizerFileName(variant) {
  return `qwen-tokenizer-12hz-${variant}.gguf`;
}

// 用哪个源（非法值一律回 official，保持宽松）：ModelScope 的文件清单里没有
// Q4_K_M 的两个 gguf，故该变体在 ModelScope 下自动回退 hf-mirror
function normalizeMirrorMode(mirror) {
  return MIRROR_MODES.has(mirror) ? mirror : 'official';
}

// 下载地址：official 走 huggingface.co，hfmirror 换成 hf-mirror.com，
// modelscope 走镜像仓库的 master 分支（与 HF 的 resolve/main 路径不同）
function modelDownloadUrl(file, mirror = 'official') {
  if (mirror === 'modelscope') {
    return `${MODEL_BASE_HOSTS.modelscope}/models/${MODELSCOPE_REPO}/resolve/master/${file}`;
  }
  const host = MODEL_BASE_HOSTS[mirror === 'hfmirror' ? 'hfmirror' : 'official'];
  return `${host}/${MODEL_REPO}/resolve/main/${file}`;
}

// 单个文件最终使用的下载地址：ModelScope 缺 Q4_K_M（变体由文件名决定），
// 遇到时改走 hf-mirror，其余情况按所选源
function resolveModelDownload(file, mirror = 'official') {
  const mode = normalizeMirrorMode(mirror);
  if (mode === 'modelscope' && String(file || '').includes('-Q4_K_M')) {
    console.log(`[ffgui] ModelScope 缺 Q4_K_M 文件（${file}），回退 hf-mirror`);
    return modelDownloadUrl(file, 'hfmirror');
  }
  return modelDownloadUrl(file, mode);
}

// ---------- 纯函数：aria2c 进度 ----------

// aria2 的 readout 形如 [#1 SIZE:12MiB/100MiB(12%) CN:4 DL:5.2MiB ETA:17s]，
// 按 \r 原地刷新。优先取尺寸对，拿不到时退回读百分比（用上一次已知总大小换算）。
const ARIA2_UNITS = { B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, TiB: 1024 ** 4 };
const ARIA2_SIZE_RE = /([\d.]+)\s*([KMGT]?i?B)\s*\/\s*([\d.]+)\s*([KMGT]?i?B)\s*\(\s*(\d{1,3})%\s*\)/;
const ARIA2_PERCENT_RE = /\(\s*(\d{1,3})%\s*\)/;

function parseAria2Readout(line, lastTotalBytes = 0) {
  const text = String(line || '');
  const m = ARIA2_SIZE_RE.exec(text);
  if (m) {
    const receivedBytes = Math.round(Number(m[1]) * (ARIA2_UNITS[m[2]] || 1)) || 0;
    const totalBytes = Math.round(Number(m[3]) * (ARIA2_UNITS[m[4]] || 1)) || 0;
    return {
      receivedBytes: totalBytes > 0 ? Math.min(receivedBytes, totalBytes) : receivedBytes,
      totalBytes,
    };
  }
  const p = ARIA2_PERCENT_RE.exec(text);
  if (!p) return null;
  // 只有百分比且不知道总大小时给不出绝对字节，交给调用方沿用上次的进度
  if (!(lastTotalBytes > 0)) return { receivedBytes: 0, totalBytes: 0 };
  const percent = Number(p[1]);
  return {
    receivedBytes: Math.min(lastTotalBytes, Math.round((lastTotalBytes * percent) / 100)),
    totalBytes: lastTotalBytes,
  };
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

// customvoice 模型的固定说话人（GGUF 的 qwen3-tts.codec.speaker_names，与上游 README
// 一致）。这份白名单同时是界面下拉的数据源（status().speakers 下发）和请求校验依据。
// 取舍：已下载模型的真实列表以 GGUF 元数据为准（引擎起来后可 GET /v1/audio/voices
// 查），但界面在引擎没起、模型没下载时也要能列出选项，为十个固定名字多跑一趟 HTTP
// 不划算，故用静态白名单；上游万一增删说话人，兜底行为是「非法值回默认」而不是失败。
const DEFAULT_SPEAKERS = [
  'Vivian', 'Alex', 'Ann', 'Davis', 'Jackson',
  'Jeff', 'Rachel', 'Ethan', 'Quinn', 'Charlotte',
];
// 默认说话人（界面初值 + 校验兜底）。写定字面量，不跟随数组顺序变化
const DEFAULT_SPEAKER = 'Vivian';

// 说话人归一：白名单内的按规范写法返回（大小写不敏感），其余一律回默认。
// 宽松处理而不用报错：说话人只影响音色，名字对不上（上游改名、旧配置残留）不该让
// 整条配音任务失败。只认字符串——数组/对象经 String() 可能拼出一个合法名字，
// 那种值按类型错误处理。
function normalizeSpeaker(value) {
  if (typeof value !== 'string') return DEFAULT_SPEAKER;
  const name = value.trim().toLowerCase();
  if (!name) return DEFAULT_SPEAKER;
  const hit = DEFAULT_SPEAKERS.find((speaker) => speaker.toLowerCase() === name);
  return hit || DEFAULT_SPEAKER;
}

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

// ---------- 纯函数：aria2c 路径 ----------

// 随包内置的 aria2c：Windows 与 macOS 随包，Linux 不内置（发行版的 aria2 足够，
// 运行时走 PATH 探测再回退内置 https 下载）。
// - 开发：<app>/bin/aria2/aria2c[.exe]
// - 打包 Windows：resources/aria2/aria2c.exe（forge extraResource 把 bin/aria2/ 映射到这）
// - 打包 macOS：resources/bin/aria2/aria2c（macOS 的 extraResource 复制整个 bin/，
//   bin/bin 与 bin/lib 的相对布局不能变），同时兼容 resources/aria2/aria2c 布局
// 随包分发即可信，命中后不再跑 --version 自检；文件不存在才返回 null。
function getBundledAria2Path(options = {}) {
  const fsImpl = options.fs || fs;
  const platform = options.platform || process.platform;
  if (platform !== 'win32' && platform !== 'darwin') return null;
  const exeName = platform === 'win32' ? 'aria2c.exe' : 'aria2c';
  const app = options.app;
  const resourcesPath = typeof options.resourcesPath === 'string' && options.resourcesPath
    ? options.resourcesPath
    : (process.resourcesPath || '');
  const candidates = [];
  if (app && app.isPackaged && resourcesPath) {
    candidates.push(path.join(resourcesPath, 'aria2', exeName));
    // macOS 走整目录复制，aria2/ 会落在 resources/bin/ 下（Windows 不会命中）
    candidates.push(path.join(resourcesPath, 'bin', 'aria2', exeName));
  }
  if (app && typeof app.getAppPath === 'function') {
    candidates.push(path.join(app.getAppPath(), 'bin', 'aria2', exeName));
  }
  for (const candidate of candidates) {
    try {
      if (fsImpl.existsSync(candidate)) return candidate;
    } catch {
      // 权限等原因无法探测，继续下一个候选
    }
  }
  return null;
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

// ---------- 纯函数：引擎返回的 WAV 校验 ----------

// 逐块走 RIFF，取 fmt / data。引擎输出可能带 LIST 等附加块，不能假设 data 在
// 固定偏移 44。dataBytes 只算文件里真实存在的字节（截断的响应不会被当成有声）。
function inspectWavBuffer(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : null;
  if (!buf || buf.length < 12) return { ok: false, reason: 'notRiff', dataBytes: 0 };
  if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') {
    return { ok: false, reason: 'notRiff', dataBytes: 0 };
  }
  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let dataBytes = 0;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('latin1', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ' && body + 16 <= buf.length) {
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
    } else if (id === 'data') {
      dataBytes = Math.max(0, Math.min(size, buf.length - body));
    }
    // RIFF 块按偶数字节对齐：奇数长度的块后面补一个填充字节
    offset = body + size + (size % 2);
  }
  if (dataBytes <= 0) {
    return { ok: false, reason: 'empty', dataBytes: 0, sampleRate, channels };
  }
  return { ok: true, reason: '', dataBytes, sampleRate, channels };
}

// 组装好的配音轨峰值低于该值即视为全静音（16bit 的绝对静音实测报 -91.0 dB，
// 真实语音峰值通常高于 -20 dB，-60 dB 留足余量）
const SILENT_MAX_DB = -60;

// 从 volumedetect 的 stderr 里取峰值（-inf 归一为 -Infinity）；解析不出返回 null，
// 调用方按"检查不了就放行"处理，不让可选检查挡住正常任务
function parseMaxVolumeDb(text) {
  const m = /max_volume:\s*(-?\d+(?:\.\d+)?|-inf)\s*dB/i.exec(String(text || ''));
  if (!m) return null;
  if (/^-inf$/i.test(m[1])) return -Infinity;
  const value = Number(m[1]);
  return Number.isFinite(value) ? value : null;
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

// 混音模式的配音音量范围（dB）。界面数字输入用同一组上下限。
const MIX_VOLUME_MIN_DB = -30;
const MIX_VOLUME_MAX_DB = 12;

// 配音音量归一：非数值（含字符串 "3"、NaN、null）回 0，越界钳到 [-30, +12]。
// 钳制而不报错的取舍：-45 dB 钳到 -30 dB 方向一致（用户要的就是"更小声"），为这个
// 纯偏好让整条配音任务失败不划算；非数值没有可推断的意图，回默认 0（与说话人的归一
// 风格一致：只影响听感，不让任务失败）。
function normalizeMixVolumeDb(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.min(MIX_VOLUME_MAX_DB, Math.max(MIX_VOLUME_MIN_DB, value));
}

// 字幕流：不保留时 -sn；MP4 系列转 mov_text（mov muxer 装不下 SRT/ASS），其余原样复制
function pushSubtitleArgs(args, { ext, keepSubtitle }) {
  if (!keepSubtitle) {
    args.push('-sn');
  } else if (ext === 'mp4' || ext === 'm4v' || ext === 'mov') {
    args.push('-c:s', 'mov_text');
  } else {
    args.push('-c:s', 'copy');
  }
}

// 混音分支：源音轨与配音轨经 amix 合成唯一一条音轨输出。
// 与多轨分支的差别全在容器选项里：没有 -map 0（源音轨不再保留），map 的是滤镜标签，
// 也没有 -c copy（音频必须重编码）。结果就是播放器里只有一条音轨，无法再切回纯原声。
function buildDubMixArgs({ video, audioWav, outPath, keepSubtitle, language, title, volumeDb }) {
  const ext = path.extname(outPath).toLowerCase().replace(/^\./, '');
  const filter = [
    // 只调配音侧：用户调的是「配音相对原声响多少」，原声保持原样（volume 的 dB 后缀
    // 内置 ffmpeg 实测可解析；混音音量恒写出来，0 dB 即恒等变换）
    `[1:a]volume=${volumeDb}dB[dub]`,
    // normalize=0：amix 默认按输入路数归一化（两路各压一半），而音量已由 dB 精确控制，
    // 不需要二次归一。duration=longest：dub.wav 与视频等长，取较长者不会截掉原声尾巴。
    // 两路采样率/声道不同由 amix 前的自动转换统一，输出再按 -ar/-ac 落成 48kHz 立体声。
    '[0:a:0][dub]amix=inputs=2:duration=longest:normalize=0[mixout]',
  ].join(';');
  const args = [
    '-hide_banner',
    '-i', video,
    '-i', audioWav,
    '-filter_complex', filter,
    // 画面复制 + 混音结果这一条音轨
    '-map', '0:v',
    '-map', '[mixout]',
  ];
  // 字幕照旧带上（-map 0:s? 的问号让没有字幕的源不报错）
  if (keepSubtitle) args.push('-map', '0:s?');
  args.push(
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '192k',
    // -ac 2 兜住声道布局：5.1 原声配单声道配音也要落成播放器默认能放的两声道
    '-ar', '48000',
    '-ac', '2',
    '-metadata:s:a:0', `language=${containerLanguageTag(language, ext)}`,
    '-metadata:s:a:0', `title=${title || t('main.dub.trackTitle')}`,
  );
  pushSubtitleArgs(args, { ext, keepSubtitle });
  // 唯一一条音轨即默认轨（单轨没有别人的 default 要摘）
  args.push('-disposition:a:0', 'default');
  args.push('-n', '-nostats', '-progress', 'pipe:1', outPath);
  return args;
}

// 混流：默认（mix=false）保留源全部流（-map 0），把组装好的音轨作为最后一条音频流
// 加入。新音轨序号 = 源音频流数量；MP4 字幕转 mov_text，MKV 原样复制。
// 默认音轨必须换成配音：播放器按 default disposition 选轨，源音轨一直是默认时
// 用户听到的还是原声，会以为"配音没混进去"（实测反馈的正是这个现象）。
// mix=true 且源有音轨时改走 buildDubMixArgs；源本来没有音轨则混音无从谈起，仍走
// 多轨分支（那种情况下它本来就只有配音一条音轨）。
function buildDubMuxArgs({
  video,
  audioWav,
  outPath,
  sourceAudioCount = 0,
  keepSubtitle = true,
  language = 'auto',
  title,
  mix = false,
  mixVolumeDb = 0,
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
  if (mix === true && index > 0) {
    return buildDubMixArgs({
      video,
      audioWav,
      outPath,
      keepSubtitle,
      language,
      title,
      volumeDb: normalizeMixVolumeDb(mixVolumeDb),
    });
  }
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
  // 源音轨全部摘掉 default（否则两条音轨都自称默认，播放器行为不确定），
  // 再把配音轨设为默认。源音轨一条不少地保留，可在播放器里手动切回。
  for (let i = 0; i < index; i += 1) args.push(`-disposition:a:${i}`, '0');
  args.push(`-disposition:a:${index}`, 'default');
  pushSubtitleArgs(args, { ext, keepSubtitle });
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
  // 说话人只影响音色，白名单外的值直接回默认（不报错），见 normalizeSpeaker
  normalized.speaker = normalizeSpeaker(job.speaker);
  // 混音开关只认布尔 true：字符串 "true"、1、null 之类一律按 false 处理，默认保持
  // 现有多轨行为。开关只决定输出结构，没有可"钳制"的中间态，宽松归一即可。
  normalized.mix = job.mix === true;
  // 配音音量（dB）：非数值回 0、越界钳到 [-30, +12]，见 normalizeMixVolumeDb
  normalized.mixVolumeDb = normalizeMixVolumeDb(job.mixVolumeDb);
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
  const resourcesPath = typeof options.resourcesPath === 'string' && options.resourcesPath
    ? options.resourcesPath
    : (process.resourcesPath || '');
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
  // aria2c 探测结果的缓存（null 表示还没探测过）
  let aria2Pending = null;

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
      // voice 取任务的说话人（customvoice 模型的固定音色），seed 固定 0：
      // 同一字幕 + 同一说话人每次合成都得到相同结果，便于复现问题；引擎里 seed
      // 传 -1 才是「不指定」，会取硬件随机数，两次配音的音色与停顿都不一样。
      const body = JSON.stringify({
        input: cue.text,
        language: state.job.language,
        voice: normalizeSpeaker(state.job.speaker),
        seed: 0,
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
      // 引擎返回一次性 RIFF（24kHz s16 单声道），校验头部与 data 段：
      // 只认魔数不够，HTTP 200 + 合法 RIFF + 空 data 段会让整条字幕静音落盘
      const wav = inspectWavBuffer(res.body);
      if (!wav.ok) {
        throw dubError('FFGUI_DUB_SYNTH', t('main.dub.errSynthesize', {
          index,
          reason: wav.reason === 'empty'
            ? t('main.dub.errAudioEmpty')
            : t('main.dub.errAudioInvalid'),
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

  // 配音轨是否整条静音：用 volumedetect 取峰值。引擎正常返回但内容是静音时，
  // 混流出来就是一个"有音轨没声音"的成品，用户只会以为配音没加上——宁可报错。
  // 探测本身失败（缺 ffmpeg / 解析不出）返回 { ok: false }，调用方放行。
  function probeAudioLevel(file) {
    return new Promise((resolve) => {
      const bin = getFfmpegPath();
      if (!bin) {
        resolve({ ok: false });
        return;
      }
      let child;
      try {
        child = spawnImpl(bin, [
          '-hide_banner', '-nostats', '-i', file, '-af', 'volumedetect', '-f', 'null', '-',
        ], { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch {
        resolve({ ok: false });
        return;
      }
      let stderr = '';
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        const maxDb = parseMaxVolumeDb(stderr);
        if (maxDb === null) {
          resolve({ ok: false });
          return;
        }
        resolve({ ok: true, silent: maxDb <= SILENT_MAX_DB, maxDb });
      };
      if (child.stderr && typeof child.stderr.on === 'function') {
        child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
      }
      // stdout 也要读空，否则管道写满会把探测挂住
      if (child.stdout && typeof child.stdout.on === 'function') child.stdout.on('data', () => {});
      child.on('error', () => {
        if (finished) return;
        finished = true;
        resolve({ ok: false });
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
      // 说话人白名单随状态一起下发，界面下拉直接用（不必等引擎起来问 /v1/audio/voices）
      speakers: DEFAULT_SPEAKERS.slice(),
    };
  }

  // ---------- 模型下载 ----------

  // aria2c 探测：优先 aria2c（支持断点续传），没有时回退内置 https 实现。
  // 优先级见 detectAria2：注入 > FFGUI_ARIA2 > 随包内置（Windows / macOS）> PATH 探测。
  // options.aria2 可注入：可执行文件路径字符串 / true（裸名 aria2c）/ false（强制
  // 不可用）/ Promise<前述任一> / { path }。未注入时先看环境变量 FFGUI_ARIA2
  // （仿 FFGUI_TTS_SERVER，便于自定义安装），再看 bin/aria2 的内置二进制（打包后
  // Windows 在 resources/aria2、macOS 在 resources/bin/aria2），最后探测 PATH。
  // 探测结果在服务生命周期内只算一次；测试默认注入 false，不会真去跑 spawn。
  function resolveAria2() {
    if (!aria2Pending) aria2Pending = detectAria2();
    return aria2Pending;
  }

  async function detectAria2() {
    // 1) 注入（测试 / 宿主定制）：可执行文件路径、true、false 或 Promise
    let injected = options.aria2;
    // 跨 realm 的 Promise 用鸭子类型判断（vm 沙箱内外 Promise 构造函数不同）
    if (injected && typeof injected.then === 'function') injected = await injected;
    if (injected !== undefined) return aria2FromValue(injected);

    // 2) 环境变量 FFGUI_ARIA2（调试 / 自定义安装）：给了完整路径也要探测，
    //    过期路径不能当成可用，探测不过就继续往下找
    const override = env.FFGUI_ARIA2;
    if (override) {
      if (await probeAria2(override)) return { path: override };
      console.log(`[ffgui] FFGUI_ARIA2 指向的 aria2c 不可用（${override}），继续尝试内置与 PATH`);
    }

    // 3) 随包内置（Windows / macOS）：存在即信任，不跑 --version 自检
    const bundled = getBundledAria2Path({ fs: fsImpl, platform, app, resourcesPath });
    if (bundled) {
      console.log(`[ffgui] 使用内置 aria2c：${bundled}`);
      return { path: bundled };
    }

    // 4) PATH 探测（Linux，以及没有随包二进制的 Windows arm64 等场景）
    if (await probeAria2('aria2c')) return { path: 'aria2c' };
    console.log('[ffgui] 未找到可用的 aria2c（内置与 PATH 均无），模型下载回退内置 https 实现');
    return null;
  }

  function aria2FromValue(value) {
    if (typeof value === 'string') return value ? { path: value } : null;
    if (value === true) return { path: 'aria2c' };
    if (value && typeof value === 'object' && typeof value.path === 'string' && value.path) {
      return { path: value.path };
    }
    return null;
  }

  // 探针：aria2c --version 退出码 0 且输出含 aria2 才认为可用（裸名由 spawn 走 PATH）
  function probeAria2(bin) {
    return new Promise((resolve) => {
      let child = null;
      let timer = null;
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        resolve(ok);
      };
      try {
        child = spawnImpl(bin, ['--version'], {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch {
        finish(false);
        return;
      }
      let header = '';
      if (child.stdout && typeof child.stdout.on === 'function') {
        child.stdout.on('data', (chunk) => {
          if (header.length < 4096) header += String(chunk);
        });
      }
      // stderr 也要读空，否则管道写满会把探针挂住
      if (child.stderr && typeof child.stderr.on === 'function') child.stderr.on('data', () => {});
      child.on('error', () => finish(false));
      child.on('close', (code) => finish(code === 0 && /aria2/i.test(header)));
      timer = setTimeout(() => {
        timer = null;
        try {
          child.kill('SIGKILL');
        } catch {
          // 已退出
        }
        finish(false);
      }, ARIA2_PROBE_TIMEOUT_MS);
    });
  }

  // 用 aria2c 下载单个文件到 target（调用方传的是 .partial 路径），返回已下载字节数。
  // -c 断点续传：同目录下 aria2 的 `<target>.aria2` 控制文件配合已有的 .partial，
  // 下次下载同一文件自动接着下；因此取消与失败都**不删**这两者（只由调用方在
  // https 回退路径上清理），中途也不切换实现（一次下载内一个文件只用一个下载器）。
  function downloadFileAria2({ bin, url, target, onChunk, signal }) {
    // 空的控制文件（下载不到 1 秒就被取消）会让下一次 -c 直接 exit 1 且不打印原因；
    // 删掉后 aria2 会按 .partial 已有长度发 Range 续传（真实 aria2 1.37 实测）
    const control = target + '.aria2';
    try {
      if (fsImpl.statSync(control).size === 0) fsImpl.unlinkSync(control);
    } catch {
      // 没有控制文件（首次下载）或没有权限，交给 aria2 自己判断
    }
    const args = [
      '-c',
      // 多连接切片：模型主机（HF / hf-mirror / ModelScope 的 CDN）都支持 Range，
      // 16 连接能明显吃满带宽；-k 1M 是 aria2 允许的最小切片下限，避免切片过小
      // 反而降低吞吐
      '-x', '16',
      '-s', '16',
      '-k', '1M',
      '-d', path.dirname(target),
      '-o', path.basename(target),
      '--file-allocation=none',
      // 模型动辄几 GB：无限重试 + 固定重试间隔，断网恢复后靠 -c 续上
      '--max-tries=0',
      '--retry-wait=5',
      '--timeout=60',
      '--connect-timeout=30',
      '--check-certificate=true',
      // 目标已存在时不能改名成 foo.1，也不能拒绝覆盖：靠 -c 续传
      '--auto-file-renaming=false',
      '--allow-overwrite=false',
      // 控制文件默认 60 秒才落盘，取消时来不及保存就等于丢掉进度
      '--auto-save-interval=1',
      '--console-log-level=notice',
      '--summary-interval=1',
      '--show-console-readout=true',
      '-U', USER_AGENT,
      url,
    ];
    return new Promise((resolve, reject) => {
      let child = null;
      let settled = false;
      let cancelled = false;
      let killTimer = null;
      let lastTotal = 0;
      let pending = '';
      let stderrTail = '';

      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        if (killTimer) {
          clearTimeout(killTimer);
          killTimer = null;
        }
        if (err) reject(err);
        else resolve(value);
      };

      const fail = (detail, params) => finish(dubError('FFGUI_DUB_DOWNLOAD',
        t('main.dub.errDownloadAria2', { detail }), params));

      // 取消：先 SIGTERM 让 aria2 收尾并写好控制文件，宽限期后再强杀
      const stopChild = () => {
        if (settled || cancelled) return;
        cancelled = true;
        try {
          child.kill('SIGTERM');
        } catch {
          // 已退出
        }
        killTimer = setTimeout(() => {
          killTimer = null;
          try {
            child.kill('SIGKILL');
          } catch {
            // 已退出
          }
        }, ARIA2_KILL_GRACE_MS);
      };

      const handleLine = (line) => {
        if (!line || line.indexOf('%') < 0) return;
        const parsed = parseAria2Readout(line, lastTotal);
        if (!parsed) return;
        if (parsed.totalBytes > 0) lastTotal = parsed.totalBytes;
        if (typeof onChunk === 'function') onChunk(parsed.receivedBytes, parsed.totalBytes);
      };

      // readout 用 \r 原地刷新，也可能出现在 stderr（重定向时），两个流都喂进来
      const feed = (chunk) => {
        pending += String(chunk);
        const parts = pending.split(/[\r\n]/);
        pending = parts.pop() || '';
        if (pending.length > 8192) pending = pending.slice(-8192);
        for (const line of parts) handleLine(line);
      };

      try {
        child = spawnImpl(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      } catch (err) {
        fail(err && err.message ? err.message : String(err), { bin });
        return;
      }
      if (child.stdout && typeof child.stdout.on === 'function') child.stdout.on('data', feed);
      if (child.stderr && typeof child.stderr.on === 'function') {
        child.stderr.on('data', (chunk) => {
          stderrTail = (stderrTail + String(chunk)).slice(-400);
          feed(chunk);
        });
      }
      child.on('error', (err) => {
        fail(err && err.message ? err.message : String(err), { bin });
      });
      child.on('close', (code) => {
        if (settled) return;
        if (cancelled) {
          finish(dubError('FFGUI_DUB_DOWNLOAD', t('main.dub.errDownloadAborted')));
          return;
        }
        if (code !== 0) {
          const tail = stderrTail.trim().split(/[\r\n]+/).filter(Boolean).pop() || '';
          fail(`exit=${code === null ? '?' : code}${tail ? `: ${tail}` : ''}`, { exitCode: code, bin });
          return;
        }
        // 退出码 0：以落盘大小为准（readout 只有百分比时也能给出准确字节数）
        let bytes = 0;
        try {
          bytes = fsImpl.statSync(target).size;
        } catch (err) {
          fail(err && err.message ? err.message : String(err), { bin, path: target });
          return;
        }
        if (!(bytes > 0)) {
          fail('exit=0, 0 bytes', { bin, path: target });
          return;
        }
        finish(null, { bytes, totalBytes: lastTotal || bytes });
      });
      if (signal && typeof signal.addEventListener === 'function') {
        if (signal.aborted) stopChild();
        else signal.addEventListener('abort', stopChild, { once: true });
      }
    });
  }

  // https 回退路径的失败清理：删掉半成品（aria2 路径保留，供下次 -c 续传）
  function discardPartial(partial, useAria2) {
    safeUnlink(partial);
    if (useAria2) safeUnlink(partial + '.aria2');
  }

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
    const mirrorMode = normalizeMirrorMode(mirror);
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
    // 本次下载使用的 aria2c（null 表示回退内置 https 实现）；一次下载内不切换
    let aria2 = null;
    try {
      fsImpl.mkdirSync(modelsDir, { recursive: true });
      aria2 = await resolveAria2();
      for (const file of files) {
        if (downloadState.cancelRequested) break;
        const target = path.join(modelsDir, file);
        const partial = target + PARTIAL_SUFFIX;
        const url = resolveModelDownload(file, mirrorMode);
        downloadState.file = file;
        downloadState.partial = partial;
        downloadState.receivedBytes = 0;
        downloadState.totalBytes = 0;
        emitTo(sender, { type: 'download-start', file, variant: variantName, mirror: mirrorMode, url });
        let lastEmit = 0;
        let lastPercent = -1;
        const onChunk = (receivedBytes, totalBytes) => {
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
        };
        const result = aria2
          ? await downloadFileAria2({
            bin: aria2.path, url, target: partial, signal: abort.signal, onChunk,
          })
          : await downloadFile({ url, target: partial, signal: abort.signal, onChunk });
        if (downloadState.cancelRequested) {
          // aria2 路径保留 .partial 与 .aria2 控制文件，下次同一文件续传
          if (!aria2) safeUnlink(partial);
          break;
        }
        try {
          fsImpl.renameSync(partial, target);
        } catch (err) {
          discardPartial(partial, Boolean(aria2));
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
      // https 回退路径：中断/失败都删掉 .partial，避免留下半截模型被误认为已下载。
      // aria2 路径相反：.partial 与控制文件是断点续传的依据，必须留着。
      if (downloadState && downloadState.partial && !aria2) {
        safeUnlink(downloadState.partial);
      }
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

      // 组装出来的音轨一条声音都没有时直接失败：混流会"成功"产出一个有音轨但
      // 全程无声的成品，比报错更难排查
      const level = await probeAudioLevel(assembledWav);
      if (state.cancelRequested) {
        state.cancelRequested = true;
        emit({ jobId: state.id, type: 'done', output: null, cancelled: true });
        return { output: null, cancelled: true, cues: cues.length };
      }
      if (level.ok && level.silent) {
        throw dubError('FFGUI_DUB_SILENT', t('main.dub.errSilentTrack'), {
          maxDb: level.maxDb === undefined ? '' : String(level.maxDb),
        });
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
        mix: normalized.mix,
        mixVolumeDb: normalized.mixVolumeDb,
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

      // 混流自检：多轨模式成品必须比源多一条音轨，否则等于交了一个没配音的文件；
      // 混音模式源音轨已被 amix 吸收，成品只剩一条（源无音轨时 mix 走的是多轨分支，
      // 期望值同样由 video.audioCount + 1 得到，恰好也是 1）
      const expectedAudio = normalized.mix && video.audioCount > 0
        ? 1
        : video.audioCount + 1;
      const output = await probeVideo(outPath);
      if (!output.ok) {
        throw dubError('FFGUI_DUB_MUX', t('main.dub.errMux', {
          reason: output.error || '',
        }), { path: outPath });
      }
      if (output.audioCount !== expectedAudio) {
        throw dubError('FFGUI_DUB_MUX',
          t('main.dub.errMux', {
            reason: t('main.dub.errOutputNoDubTrack', {
              expected: expectedAudio,
              actual: output.audioCount,
            }),
          }),
          { expected: expectedAudio, actual: output.audioCount, path: outPath });
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
  getBundledAria2Path,
  modelDownloadUrl,
  resolveModelDownload,
  normalizeMirrorMode,
  parseAria2Readout,
  talkerFileName,
  tokenizerFileName,
  languageToBcp47,
  containerLanguageTag,
  resolveContainerExt,
  uniqueOutputPath,
  backendEnv,
  inspectWavBuffer,
  parseMaxVolumeDb,
  normalizeSpeaker,
  normalizeMixVolumeDb,
  // 常量
  LANGUAGES,
  MODEL_VARIANTS,
  DEFAULT_SPEAKERS,
  DEFAULT_SPEAKER,
  MIX_VOLUME_MIN_DB,
  MIX_VOLUME_MAX_DB,
  MAX_CUES,
  MAX_CUE_CHARS,
  MAX_AMIX_INPUTS,
  SILENT_MAX_DB,
  EVENT_CHANNEL,
};
