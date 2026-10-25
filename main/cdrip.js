'use strict';

// CD 抓轨（音频 CD）主进程模块。
//
// 与 main/disc.js 的分工：disc.js 面向 DVD / Blu-ray 的视频标题抓取（Rust 侧车
// freemkv 引擎，输出 MKV/MP4）；本模块面向音乐 CD 的逐轨音频抓取，直接复用
// main/ffmpeg.js 的 libcdio 输入设备读取 44.1kHz/16bit PCM，编码为 FLAC 无损。
//
// 三平台一致性：Windows 内置 ffmpeg（gyan full_build）与 macOS 自建构建均已
// 开启 --enable-libcdio，Linux 用系统 ffmpeg（需其带 libcdio）。libcdio 的
// 设备名按平台不同：Windows 用盘符 "E:"，macOS 用 "/dev/rdiskN"，
// Linux 用 "/dev/srN" 或 "/dev/cdrom"。
//
// 抓取方式与 runSingleFileConversion 的区别：后者输入是文件路径，本模块输入是
// libcdio 设备 + -ss/-t 定位单轨，因此自行 spawn ffmpeg（仍复用
// -progress pipe:1 的解析与取消模式），并把 TOC 偏移换算成秒。

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { t } = require('./i18n');
const { getFfmpegPath } = require('./ffmpeg');

// CD 的物理常量：每扇区 2352 字节、每秒 75 扇区、16bit 立体声 44100Hz。
const CD_SECTOR_BYTES = 2352;
const CD_FRAMES_PER_SEC = 75;
const CD_BYTES_PER_FRAME = CD_SECTOR_BYTES;
// 44.1kHz × 2 声道 × 2 字节 = 176400 B/s，与 75 × 2352 完全一致
const CD_BYTES_PER_SEC = 176400;

const PARTIAL_SUFFIX = '.ffgui-partial';
const OUTPUT_FORMAT = 'flac';
// FLAC 压缩级别：8 是官方推荐的无损/体积平衡点（0 最快最大，12 最慢最小）
const DEFAULT_COMPRESSION = 8;
const COMPRESSION_LEVELS = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
const PARANOIA_MODES = new Set(['disable', 'verify', 'overlap', 'neverskip', 'full']);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cdError(code, message, params = {}) {
  const err = new Error(message);
  err.code = code;
  err.params = params;
  return err;
}

function invalid(field, message) {
  return cdError('FFGUI_CD_INVALID_JOB', message, { field });
}

function requiredString(value, field) {
  if (typeof value !== 'string' || !value) throw invalid(field, t('main.cd.errRequired', { field }));
  return value;
}

// ---------- 设备名与路径 ----------

// libcdio 的设备名按平台换算：
// - Windows：盘符 "E:"（libcdio win32 驱动的 cdio_is_device_win32 只认
//   两位形态 "X:"，"\\.\CdRom0" 这类设备路径它并不支持，直接拒绝）
// - macOS：BSD 原始设备 "/dev/rdiskN"（rdisk 是绕过缓存的字符设备，读 CD 必须用）
// - Linux：块设备 "/dev/srN" 或 "/dev/cdrom"；libfreemkv 枚举出的是 sg 字符设备
//   "/dev/sgN"，libcdio 打不开它，先按同号启发式换成 sr 块设备（同一光驱，
//   sgN 与 srN 编号一致）——该映射尚未真机验证
function normalizeDevicePath(raw, platform = process.platform) {
  const value = String(raw || '').trim();
  if (!value) return '';
  if (platform === 'win32') {
    // 接受 "E:"、"e:"、"E"、"\\.\E:" 等写法，统一成单字母盘符；
    // 其余形态（如 "\\.\CdRom0"）libcdio 打不开，一律拒绝
    const simple = value.match(/^([A-Za-z]):?$/);
    if (simple) return `${simple[1].toUpperCase()}:`;
    const stripped = value.replace(/^[\\/.]+/, '');
    const letter = stripped.match(/^([A-Za-z]):?$/);
    return letter ? `${letter[1].toUpperCase()}:` : '';
  }
  if (platform === 'darwin') {
    // 只接受 /dev/rdiskN 或 /dev/diskN（后者转成 rdisk）
    const m = value.match(/^\/dev\/(r?disk(\d+))$/);
    if (m) return `/dev/rdisk${m[2]}`;
    return '';
  }
  // Linux：libfreemkv 给的是 sg 字符设备 /dev/sgN，libcdio 打不开，
  // 按同号启发式换成 sr 块设备（sgN 与 srN 是同一光驱）；该映射未经真机验证。
  // 只映射 sg 前缀 + 纯数字后缀，/dev/sr0、/dev/cdrom、/dev/dvd 等原样通过
  const sg = value.match(/^\/dev\/sg(\d+)$/);
  if (sg) return `/dev/sr${sg[1]}`;
  return /^\/dev\/[\w.-]+$/.test(value) ? value : '';
}

// ---------- TOC 解析 ----------

// 解析 ffmpeg -i <libcdio 设备> 的 stderr，取出每轨起止时间与标题。
// libcdio 的 read_header 用 avpriv_new_chapter 为每轨建一个章节，标题形如
// "track 01"；ffmpeg 输出形如：
//   Chapters:
//     Chapter #0:0: start 0.000000, end 4.053333
//       Metadata:
//         title           : track 01
function parseCdToc(stderr) {
  const lines = String(stderr || '').split(/\r?\n/);
  const chapters = [];
  let current = null;
  let inChapters = false;
  let pendingChapter = false;
  for (const line of lines) {
    if (!inChapters) {
      if (/^\s*Chapters:\s*$/.test(line)) inChapters = true;
      continue;
    }
    const chapterMatch = line.match(/^\s*Chapter #\d+:\d+:\s*start\s+([\d.]+),\s*end\s+([\d.]+)\s*$/);
    if (chapterMatch) {
      if (current) chapters.push(current);
      current = {
        start: Number(chapterMatch[1]),
        end: Number(chapterMatch[2]),
        title: '',
      };
      pendingChapter = true;
      continue;
    }
    if (pendingChapter && current) {
      const titleMatch = line.match(/^\s*title\s*:\s*(.+?)\s*$/);
      if (titleMatch) {
        current.title = titleMatch[1];
        pendingChapter = false;
      }
    }
  }
  if (current) chapters.push(current);
  return chapters
    .filter((c) => Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start)
    .map((c, index) => ({
      // libcdio 的章节顺序即物理轨序，轨号从 1 开始
      number: index + 1,
      start: c.start,
      end: c.end,
      duration: c.end - c.start,
      title: c.title,
    }));
}

// ---------- MusicBrainz DiscID ----------

// MusicBrainz DiscID 算法，与 libdiscid 的 create_disc_id 逐位一致
// （实现依据 libdiscid 源码 src/disc.c 与 src/base64.c，并用其官方测试向量
//  test_put.c 的 "xUp1F2NkfP8s8jaeFn_Av3jNEI4-" 校验过）。
//
// 关键细节（照抄 libdiscid 的数组布局，否则哈希对不上）：
// 1. SHA1 输入是 ASCII 十六进制字符串：首轨号(2位) + 末轨号(2位) + 100 个
//    8 位十六进制偏移槽位；槽位 [0] 放 lead-out 帧，[1..n] 放各轨起始帧，
//    其余补 0（libdiscid 的 discid_put 就是按这个顺序写 track_offsets 的）。
// 2. base64 用字母表 A-Za-z0-9._，尾部不足 3 字节用 '-' 补齐，每 60 字符插
//    CRLF（最终去掉换行）。
// 注意：libdiscid 的 discid_get_id 只返回这个 base64 串本身（官方测试向量
// "xUp1F2NkfP8s8jaeFn_Av3jNEI4-" 尾部的 '-' 就是 base64 的补齐符，并非秒数）。
// MusicBrainz 的 discid 查询接口接受的正是这个形态；光盘秒数由 toc 参数另行传递。
function musicbrainzDiscId(trackStartFrames, leadOutFrame) {
  const crypto = require('crypto');
  const first = 1;
  const last = trackStartFrames.length;
  let input = '';
  input += first.toString(16).toUpperCase().padStart(2, '0');
  input += last.toString(16).toUpperCase().padStart(2, '0');
  // 槽位 0 = lead-out，其后是各轨起始帧，固定 100 个槽位
  const slots = [Math.round(leadOutFrame)];
  for (const frame of trackStartFrames.slice(0, 99)) slots.push(Math.round(frame));
  while (slots.length < 100) slots.push(0);
  for (const frame of slots) input += frame.toString(16).toUpperCase().padStart(8, '0');
  const digest = crypto.createHash('sha1').update(Buffer.from(input, 'ascii')).digest();
  return rfc822Base64(digest).replace(/\r\n/g, '');
}

// libdiscid 的 rfc822_binary：字母表 A-Za-z0-9._，尾部不足 3 字节用 '-' 补齐，
// 每 60 字符（15 组）插 CRLF（此处统一去掉换行）
function rfc822Base64(src) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._';
  let out = '';
  let group = 0;
  let remaining = src.length;
  let offset = 0;
  while (remaining > 0) {
    out += alphabet[src[offset] >> 2];
    out += alphabet[((src[offset] << 4) + (--remaining ? (src[offset + 1] >> 4) : 0)) & 0x3f];
    out += remaining ? alphabet[((src[offset + 1] << 2) + (--remaining ? (src[offset + 2] >> 6) : 0)) & 0x3f] : '-';
    out += remaining ? alphabet[src[offset + 2] & 0x3f] : '-';
    if (remaining) remaining -= 1;
    offset += 3;
    group += 1;
    if (group === 15) {
      group = 0;
      out += '\r\n';
    }
  }
  return out;
}

// 秒 -> CD 扇区（75/秒），与 ffmpeg 的章节 start/end 换算保持同一时钟
function secondsToFrames(seconds) {
  return Math.round(seconds * CD_FRAMES_PER_SEC);
}

// MusicBrainz 的 toc 查询串：首轨 末轨 leadout 每轨起始扇区（空格分隔）
function buildMusicbrainzToc(trackStartFrames, leadOutFrame) {
  return [1, trackStartFrames.length, leadOutFrame, ...trackStartFrames]
    .map((n) => String(Math.round(n)))
    .join(' ');
}

// ---------- 探测 ----------

async function runFfmpegCapture(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(getFfmpegPath(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let stdout = '';
    let stderrTail = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      stderrTail = (stderrTail + chunk.toString()).slice(-8000);
    });
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, stderr, stdout, stderrTail });
    });
  });
}

// 探测一张 CD：读 TOC 并换算成轨列表。不读音频数据，代价与开盘相当。
async function probeCd(devicePath) {
  if (!devicePath) throw invalid('device', t('main.cd.errDeviceMissing'));
  const result = await runFfmpegCapture([
    '-hide_banner',
    // 只读头部就退出：不抓音频，探测很快
    '-f', 'libcdio',
    '-i', devicePath,
    '-frames:a', '0',
    '-f', 'null',
    '-',
  ]);
  const stderr = result.stderr || '';
  if (/Could not open drive/i.test(stderr) || /Could not open disk/i.test(stderr)
      || /could not read TOC/i.test(stderr)) {
    throw cdError('FFGUI_CD_NO_DISC', t('main.cd.errNoDisc', { device: devicePath }), {
      device: devicePath,
    });
  }
  const tracks = parseCdToc(stderr);
  if (tracks.length === 0) {
    throw cdError('FFGUI_CD_NO_TRACKS', t('main.cd.errNoTracks', { device: devicePath }), {
      device: devicePath,
    });
  }
  const trackStartFrames = tracks.map((track) => secondsToFrames(track.start));
  const leadOutFrame = secondsToFrames(tracks[tracks.length - 1].end);
  return {
    device: devicePath,
    trackCount: tracks.length,
    durationSecs: leadOutFrame / CD_FRAMES_PER_SEC,
    tracks,
    trackStartFrames,
    leadOutFrame,
    discId: musicbrainzDiscId(trackStartFrames, leadOutFrame),
    toc: buildMusicbrainzToc(trackStartFrames, leadOutFrame),
  };
}

// ---------- MusicBrainz 元数据 ----------

const MB_USER_AGENT = 'FFGui/1.0 (https://github.com/kisaragychihaya/ffgui)';
const MB_TIMEOUT_MS = 15000;

function httpsGetJson(url) {
  const https = require('https');
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': MB_USER_AGENT, Accept: 'application/json' },
      timeout: MB_TIMEOUT_MS,
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(cdError('FFGUI_CD_MB_HTTP',
            t('main.cd.errMbHttp', { status: res.statusCode }), { status: res.statusCode }));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(cdError('FFGUI_CD_MB_BAD_JSON', t('main.cd.errMbBadJson'), { cause: err.message }));
        }
      });
    });
    req.on('timeout', () => {
      req.destroy(cdError('FFGUI_CD_MB_TIMEOUT', t('main.cd.errMbTimeout')));
    });
    req.on('error', (err) => {
      reject(cdError('FFGUI_CD_MB_NETWORK',
        t('main.cd.errMbNetwork', { reason: err && err.message ? err.message : String(err) })));
    });
  });
}

// 按 TOC 查 MusicBrainz 发行信息。返回统一的 release 视图（可能多个候选），
// 由界面让用户挑选；网络失败只抛错，调用方决定是否降级为手动填写。
async function lookupMusicbrainz(toc) {
  const url = `https://musicbrainz.org/ws/2/discid/?fmt=json&toc=${encodeURIComponent(toc)}`;
  const data = await httpsGetJson(url);
  const releases = Array.isArray(data.releases) ? data.releases : [];
  return {
    releaseCount: typeof data['release-count'] === 'number' ? data['release-count'] : releases.length,
    releases: releases.map((release) => ({
      id: release.id,
      title: String(release.title || ''),
      artist: artistCreditName(release['artist-credit']),
      date: String(release.date || ''),
      country: release.country ? String(release.country) : '',
      barcode: release.barcode ? String(release.barcode) : '',
      status: release.status ? String(release.status) : '',
      trackCount: mediaTrackCount(release.media),
    })),
  };
}

function artistCreditName(credit) {
  if (!Array.isArray(credit)) return '';
  return credit.map((entry) => String((entry && entry.name) || '')).join('');
}

function mediaTrackCount(media) {
  if (!Array.isArray(media)) return 0;
  for (const entry of media) {
    if (entry && typeof entry['track-count'] === 'number') return entry['track-count'];
  }
  return 0;
}

// 取某个 release 的逐曲信息（曲名 / 演唱者 / 时长毫秒）
async function fetchReleaseTracks(releaseId) {
  const url = `https://musicbrainz.org/ws/2/release/${encodeURIComponent(releaseId)}`
    + '?fmt=json&inc=recordings+artist-credits';
  const data = await httpsGetJson(url);
  const media = Array.isArray(data.media) ? data.media : [];
  const tracks = [];
  for (const entry of media) {
    if (!entry || !Array.isArray(entry.tracks)) continue;
    for (const track of entry.tracks) {
      tracks.push({
        position: Number(track.position) || tracks.length + 1,
        title: String(track.title || ''),
        artist: artistCreditName(track['artist-credit']),
        lengthMs: Number(track.length) || 0,
      });
    }
  }
  tracks.sort((a, b) => a.position - b.position);
  return {
    id: String(data.id || releaseId),
    title: String(data.title || ''),
    artist: artistCreditName(data['artist-credit']),
    date: String(data.date || ''),
    barcode: data.barcode ? String(data.barcode) : '',
    tracks,
  };
}

// ---------- 抓取 ----------

// FLAC 标签名（ffmpeg -metadata 接受的 Vorbis comment 键）
const TAG_KEYS = {
  album: 'album',
  albumArtist: 'album_artist',
  artist: 'artist',
  title: 'title',
  track: 'track',
  disc: 'disc',
  date: 'date',
  genre: 'genre',
  barcode: 'barcode',
  comment: 'comment',
};

function safeFilePart(value, fallback) {
  let text = String(value || '')
    .replace(/[\x00-\x1f\x7f]+/g, '_')
    .replace(/[\\/<>:"|?*]+/g, '_')
    .trim()
    .replace(/^[. ]+|[. ]+$/g, '');
  if (!text) text = fallback;
  if (text.length > 120) text = text.slice(0, 120).replace(/[. ]+$/g, '');
  return text || fallback;
}

function pathKey(file) {
  const resolved = path.resolve(file);
  return process.platform === 'linux' ? resolved : resolved.toLowerCase();
}

function uniqueOutputPath(candidate, reserved, fsImpl) {
  const ext = path.extname(candidate);
  const stem = candidate.slice(0, candidate.length - ext.length);
  let out = candidate;
  let suffix = 2;
  const unavailable = (p) => fsImpl.existsSync(p) || reserved.has(pathKey(p));
  while (unavailable(out)) out = `${stem}_${suffix++}${ext}`;
  reserved.add(pathKey(out));
  return out;
}

// 组装单轨文件名：专辑名 + 曲序，专辑名缺失时退化为 "CD Track NN"
function trackFileName(album, trackNumber) {
  const prefix = album ? safeFilePart(album, 'CD') : 'CD';
  const seq = String(trackNumber).padStart(2, '0');
  return `${prefix} - ${seq}`;
}

function validateCdJob(job) {
  if (!isPlainObject(job)) throw invalid('job', t('main.cd.errJobObject'));
  const normalized = {
    id: requiredString(job.id, 'id'),
    device: requiredString(job.device, 'device'),
    outputDir: requiredString(job.outputDir, 'outputDir'),
    compression: DEFAULT_COMPRESSION,
    paranoiaMode: 'disable',
    metadata: null,
    tracks: [],
  };
  const device = normalizeDevicePath(job.device);
  if (!device) throw invalid('device', t('main.cd.errDeviceBad', { device: job.device }));
  normalized.device = device;
  if (job.compression !== undefined && job.compression !== null) {
    const level = Number(job.compression);
    if (!COMPRESSION_LEVELS.has(level)) {
      throw invalid('compression', t('main.cd.errCompression', { level: String(job.compression) }));
    }
    normalized.compression = level;
  }
  if (job.paranoiaMode !== undefined && job.paranoiaMode !== null && job.paranoiaMode !== '') {
    if (!PARANOIA_MODES.has(job.paranoiaMode)) {
      throw invalid('paranoiaMode', t('main.cd.errParanoia', { mode: String(job.paranoiaMode) }));
    }
    normalized.paranoiaMode = job.paranoiaMode;
  }
  normalized.metadata = normalizeMetadata(job.metadata);
  if (!Array.isArray(job.tracks) || job.tracks.length === 0) {
    throw invalid('tracks', t('main.cd.errNoTracksSelected'));
  }
  const numbers = new Set();
  normalized.tracks = job.tracks.map((entry, index) => {
    if (!isPlainObject(entry)) throw invalid(`tracks.${index}`, t('main.cd.errTrackObject'));
    const number = Number(entry.number);
    if (!Number.isSafeInteger(number) || number < 1 || number > 99) {
      throw invalid(`tracks.${index}.number`, t('main.cd.errTrackNumber', { value: String(entry.number) }));
    }
    if (numbers.has(number)) {
      throw invalid(`tracks.${index}.number`, t('main.cd.errTrackDuplicate', { number }));
    }
    numbers.add(number);
    // 起止秒：必须由探测结果带回来，不能只给轨号（盘可能已被更换）。
    // end 必须大于 start，否则 -t 会得到非正时长，ffmpeg 直接失败。
    const start = finiteNumber(entry.start, `tracks.${index}.start`);
    const end = finiteNumber(entry.end, `tracks.${index}.end`);
    if (end <= start) {
      throw invalid(`tracks.${index}.end`, t('main.cd.errTrackOrder', { number }));
    }
    return {
      number,
      start,
      end,
      title: typeof entry.title === 'string' ? entry.title.slice(0, 300) : '',
    };
  });
  normalized.tracks.sort((a, b) => a.number - b.number);
  return normalized;
}

function finiteNumber(value, field) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw invalid(field, t('main.cd.errTrackRange', { field }));
  return n;
}

// 元数据：专辑级字段 + 每轨覆盖。只接受字符串，长度截断，绝不参与命令行拼接
// （标签值一律经 -metadata key=value 传入，ffmpeg 按单个 argv 处理）。
function normalizeMetadata(metadata) {
  if (metadata === null || metadata === undefined) return null;
  if (!isPlainObject(metadata)) throw invalid('metadata', t('main.cd.errMetadataObject'));
  const out = { album: '', albumArtist: '', artist: '', date: '', genre: '', disc: '', barcode: '', comment: '' };
  for (const key of Object.keys(out)) {
    const value = metadata[key];
    if (value === undefined || value === null || value === '') continue;
    if (typeof value !== 'string') throw invalid(`metadata.${key}`, t('main.cd.errMetadataField', { field: key }));
    out[key] = value.slice(0, 300);
  }
  const perTrack = {};
  if (metadata.tracks !== undefined && metadata.tracks !== null) {
    if (!isPlainObject(metadata.tracks)) throw invalid('metadata.tracks', t('main.cd.errMetadataTracks'));
    for (const [key, value] of Object.entries(metadata.tracks)) {
      const num = Number(key);
      if (!Number.isSafeInteger(num) || num < 1) continue;
      if (!isPlainObject(value)) throw invalid(`metadata.tracks.${key}`, t('main.cd.errMetadataTrack'));
      const entry = {};
      if (value.title !== undefined && value.title !== null) {
        if (typeof value.title !== 'string') {
          throw invalid(`metadata.tracks.${key}.title`, t('main.cd.errMetadataField', { field: 'title' }));
        }
        entry.title = value.title.slice(0, 300);
      }
      if (value.artist !== undefined && value.artist !== null) {
        if (typeof value.artist !== 'string') {
          throw invalid(`metadata.tracks.${key}.artist`, t('main.cd.errMetadataField', { field: 'artist' }));
        }
        entry.artist = value.artist.slice(0, 300);
      }
      perTrack[num] = entry;
    }
  }
  out.tracks = perTrack;
  return out;
}

function buildMetadataArgs(track, metadata) {
  const args = [];
  if (!metadata) return args;
  const perTrack = (metadata.tracks && metadata.tracks[track.number]) || {};
  const values = {
    album: metadata.album,
    albumArtist: metadata.albumArtist,
    artist: perTrack.artist || metadata.artist,
    title: perTrack.title || track.title,
    track: String(track.number),
    disc: metadata.disc,
    date: metadata.date,
    genre: metadata.genre,
    barcode: metadata.barcode,
    comment: metadata.comment,
  };
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === '') continue;
    args.push('-metadata', `${TAG_KEYS[key]}=${value}`);
  }
  return args;
}

function buildCdTrackArgs({ device, track, output, compression, paranoiaMode, metadata }) {
  const args = [
    '-hide_banner',
    // libcdio 输入设备的参数必须放在 -f 之后、-i 之前
    '-f', 'libcdio',
  ];
  if (paranoiaMode && paranoiaMode !== 'disable') {
    args.push('-paranoia_mode', paranoiaMode);
  }
  // -ss 放在 -i 前：libcdio 的 read_seek 支持快速定位，避免从头读整盘
  args.push('-ss', String(track.start));
  args.push('-i', device);
  // 元数据是输出侧选项，必须放在 -i 之后（放在前面会被当成输入选项而报错）
  args.push(...buildMetadataArgs(track, metadata));
  args.push(
    '-map', '0:a:0',
    '-c:a', 'flac',
    // 半成品后缀是 .ffgui-partial，ffmpeg 无法从扩展名推断封装，必须显式指定
    '-f', OUTPUT_FORMAT,
    '-compression_level', String(compression),
    // CD 原生就是 16bit/44100Hz，显式锁定避免某些盘报成 24bit 触发实验警告
    '-sample_fmt', 's16',
    '-ar', '44100',
    '-ac', '2',
    '-t', String(track.duration),
    // 只传 -n：同时传 -y 会因参数互斥直接失败（已实测）
    '-n',
    '-nostats',
    '-progress', 'pipe:1',
  );
  args.push(output);
  return args;
}

function parseTimeToSeconds(value) {
  const m = String(value || '').match(/(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!m) return 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

// 单轨抓取：spawn ffmpeg，解析 -progress，取消时删除本次新产生的半成品
function ripCdTrack({ device, track, output, compression, paranoiaMode, metadata, onProgress, onLog, control }) {
  return new Promise((resolve) => {
    const partial = output + PARTIAL_SUFFIX;
    const outputExisted = fs.existsSync(output);
    const args = buildCdTrackArgs({
      device, track, output: partial, compression, paranoiaMode, metadata,
    });
    const child = spawn(getFfmpegPath(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
    if (control) control.child = child;

    let outBuffer = '';
    let kv = {};
    let stderrTail = '';
    let errLineBuf = '';
    let progressEnded = false;
    let finished = false;

    const sendProgress = (percent) => {
      if (typeof onProgress === 'function') onProgress(percent);
    };

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
        const percent = track.duration > 0
          ? Math.min(99, Math.round((timeSec / track.duration) * 100)) : 0;
        sendProgress(percent);
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
      cleanup(partial, true);
      resolve({ ok: false, cancelled: false, error: String(err && err.message ? err.message : err) });
    });

    child.on('close', (code) => {
      if (finished) return;
      finished = true;
      if (errLineBuf.trim()) console.log(`[ffmpeg] ${errLineBuf.trim()}`);
      const cancelled = Boolean(control && control.cancelled);
      if (cancelled) {
        cleanup(partial, true);
        resolve({ ok: false, cancelled: true });
        return;
      }
      // 部分 ffmpeg 构建在 -n 拒绝覆盖时仍返回 0，必须同时收到 progress=end
      if (code === 0 && progressEnded) {
        try {
          fs.renameSync(partial, output);
        } catch (err) {
          cleanup(partial, true);
          // 半成品缺失说明 ffmpeg 报成功却没落盘（磁盘满 / 权限 / 被杀软拦截），
          // 必须明确告知而不是甩一个 ENOENT
          const reason = err && err.code === 'ENOENT'
            ? t('main.cd.errOutputMissing', { output })
            : (err && err.message ? err.message : String(err));
          resolve({ ok: false, cancelled: false, error: reason });
          return;
        }
        sendProgress(100);
        resolve({ ok: true, output });
        return;
      }
      cleanup(partial, true);
      const tail = stderrTail.split(/\r?\n/).filter(Boolean).slice(-5).join('\n');
      const reason = code === 0 ? t('main.err.ffmpegIncompleteOutput') : t('main.err.ffmpegExitCode', { code });
      resolve({ ok: false, cancelled: false, error: `${reason}\n${tail}` });
    });

    function cleanup(file, remove) {
      if (!remove) return;
      try {
        fs.unlinkSync(file);
      } catch (err) {
        if (err && err.code === 'ENOENT') return;
        console.log(`[ffgui] 删除未完成的抓轨输出失败: ${file} (${err && err.message ? err.message : err})`);
      }
    }
  });
}

function createCdService(options = {}) {
  const fsImpl = options.fs || fs;
  let activeJob = null;

  async function probe(source) {
    const device = normalizeDevicePath(isPlainObject(source) ? source.device : source);
    if (!device) throw invalid('device', t('main.cd.errDeviceBad', { device: String(source) }));
    return probeCd(device);
  }

  function cancel(jobId) {
    const state = activeJob;
    if (!state || state.id !== jobId) return false;
    state.cancelRequested = true;
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
    if (activeJob) throw cdError('FFGUI_CD_BUSY', t('main.cd.errBusy'));
    const normalized = validateCdJob(job);
    const state = {
      id: normalized.id,
      job: normalized,
      sender,
      cancelRequested: false,
      control: {},
    };
    activeJob = state;
    const emit = (event) => {
      if (!sender || (typeof sender.isDestroyed === 'function' && sender.isDestroyed())) return;
      try {
        sender.send('ffgui:cd-event', event);
      } catch {
        // 窗口关闭不应打断抓取
      }
    };
    const events = { done: 0, total: 0, errors: [], cancelled: false };
    try {
      const outputDir = path.resolve(normalized.outputDir);
      let stat;
      try {
        stat = fsImpl.statSync(outputDir);
      } catch (err) {
        throw cdError('FFGUI_CD_OUTPUT_DIR',
          t('main.cd.errOutputDirUnusable', { path: normalized.outputDir }),
          { path: normalized.outputDir, cause: err && err.message ? err.message : String(err) });
      }
      if (!stat.isDirectory()) {
        throw cdError('FFGUI_CD_OUTPUT_DIR',
          t('main.cd.errOutputNotDir', { path: normalized.outputDir }), { path: normalized.outputDir });
      }
      const reserved = new Set();
      const album = normalized.metadata ? normalized.metadata.album : '';
      // 先分配全部输出，避免抓到一半才发现重名
      const plans = normalized.tracks.map((track) => ({
        track,
        output: uniqueOutputPath(
          path.join(outputDir, `${trackFileName(album, track.number)}.${OUTPUT_FORMAT}`),
          reserved, fsImpl),
        existed: false,
      }));
      for (const plan of plans) plan.existed = fsImpl.existsSync(plan.output);
      events.total = plans.length;
      emit({ jobId: state.id, type: 'start', total: plans.length });

      for (const plan of plans) {
        if (state.cancelRequested) break;
        const { track, output } = plan;
        emit({
          jobId: state.id,
          type: 'track-start',
          trackId: track.number,
          output,
        });
        let completed = false;
        try {
          const result = await ripCdTrack({
            device: normalized.device,
            track,
            output,
            compression: normalized.compression,
            paranoiaMode: normalized.paranoiaMode,
            metadata: normalized.metadata,
            control: state.control,
            onProgress: (percent) => {
              emit({
                jobId: state.id,
                type: 'progress',
                trackId: track.number,
                output,
                percent,
              });
            },
            onLog: (text) => {
              emit({
                jobId: state.id,
                type: 'log',
                level: 'info',
                code: 'CD_RIP',
                message: text.trim().slice(0, 500),
              });
            },
          });
          if (result.ok) {
            completed = true;
            events.done += 1;
            emit({ jobId: state.id, type: 'track-done', trackId: track.number, output });
            continue;
          }
          if (result.cancelled || state.cancelRequested) {
            state.cancelRequested = true;
            break;
          }
          throw cdError('FFGUI_CD_RIP_FAILED',
            t('main.cd.errRipFailed', { track: track.number }),
            { message: result.error || t('main.cd.ffmpegIncomplete') });
        } catch (err) {
          if (state.cancelRequested || (err && err.code === 'cancelled')) {
            state.cancelRequested = true;
            break;
          }
          const code = err && typeof err.code === 'string' ? err.code : 'FFGUI_CD_FAILED';
          const params = err && isPlainObject(err.params)
            ? err.params : { message: err && err.message ? err.message : String(err) };
          emit({ jobId: state.id, type: 'track-error', trackId: track.number, output, code, params });
          events.errors.push({ trackId: track.number, code, params });
        } finally {
          if (!completed && !plan.existed) {
            try {
              fsImpl.unlinkSync(output);
            } catch (err) {
              if (err && err.code !== 'ENOENT') {
                emit({
                  jobId: state.id,
                  type: 'log',
                  level: 'warning',
                  code: 'FFGUI_CD_CLEANUP_FAILED',
                  params: { path: output, reason: err && err.message ? err.message : String(err) },
                  message: t('main.cd.cleanupFailed', { path: output }),
                });
              }
            }
          }
        }
      }

      events.cancelled = state.cancelRequested;
      emit({
        jobId: state.id,
        type: 'done',
        total: events.total,
        done: events.done,
        cancelled: events.cancelled,
      });
      return { total: events.total, done: events.done, cancelled: events.cancelled, errors: events.errors };
    } finally {
      if (activeJob === state) activeJob = null;
    }
  }

  return { probe, start, cancel };
}

// ---------- IPC 注册 ----------

// 枚举本机光驱。复用光盘抓取的 Rust 侧车（libfreemkv 每平台 sysfs / IOKit /
// SetupAPI 遍历 + 一次 INQUIRY），把侧车条目里的 path 换算成 libcdio 能认的
// 设备名：Windows 的 "E:"、macOS 的 "/dev/rdiskN"、Linux 的 "/dev/srN"。
// 侧车不可用或平台不支持时返回结构化原因，界面据此引导用户改走 ISO 镜像。
function registerCdIpc() {
  const { ipcMain } = require('electron');
  const { t: translate } = require('./i18n');
  const service = createCdService();

  async function listCdDrives() {
    const { createDiscService } = require('./disc');
    const discService = createDiscService({
      app: require('electron').app,
    });
    try {
      const result = await discService.listDrives();
      if (result && result.code) {
        return { drives: [], code: result.code };
      }
      const drives = [];
      for (const entry of (result && result.drives) || []) {
        // 侧车每个条目只产出 kind/path/label：path 是设备路径
        // （Windows 为 "\\.\E:" 形态，"\\.\CdRom0" 换算为空、被跳过属预期；
        // label 仅供界面展示，不保证是设备路径）。
        // 换算不出合法 libcdio 设备名的条目直接跳过，不让界面选中后必然失败。
        const device = normalizeDevicePath(entry && typeof entry.path === 'string' ? entry.path : '');
        if (!device) continue;
        drives.push({
          device,
          label: entry && typeof entry.label === 'string' ? entry.label : device,
          vendor: entry && typeof entry.vendor === 'string' ? entry.vendor : '',
          model: entry && typeof entry.model === 'string' ? entry.model : '',
        });
      }
      return { drives };
    } catch (err) {
      return {
        drives: [],
        code: err && typeof err.code === 'string' ? err.code : 'FFGUI_CD_DRIVES_FAILED',
        message: err && err.message ? err.message : String(err),
      };
    }
  }

  ipcMain.handle('ffgui:cd-list-drives', () => listCdDrives());
  ipcMain.handle('ffgui:cd-probe', (_event, device) => service.probe({ device }));
  ipcMain.handle('ffgui:cd-lookup', (_event, toc) => {
    if (typeof toc !== 'string' || !toc.trim()) {
      throw cdError('FFGUI_CD_INVALID_JOB', translate('main.cd.errTocMissing'));
    }
    return lookupMusicbrainz(toc.trim());
  });
  ipcMain.handle('ffgui:cd-release-tracks', (_event, releaseId) => {
    if (typeof releaseId !== 'string' || !releaseId.trim()) {
      throw cdError('FFGUI_CD_INVALID_JOB', translate('main.cd.errReleaseIdMissing'));
    }
    return fetchReleaseTracks(releaseId.trim());
  });
  ipcMain.handle('ffgui:cd-start', (event, job) => service.start(event.sender, job));
  ipcMain.handle('ffgui:cd-cancel', (_event, jobId) => service.cancel(jobId));
}

module.exports = {
  createCdService,
  validateCdJob,
  normalizeDevicePath,
  parseCdToc,
  musicbrainzDiscId,
  rfc822Base64,
  buildMusicbrainzToc,
  secondsToFrames,
  trackFileName,
  buildCdTrackArgs,
  buildMetadataArgs,
  lookupMusicbrainz,
  fetchReleaseTracks,
  registerCdIpc,
  CD_FRAMES_PER_SEC,
  CD_SECTOR_BYTES,
  CD_BYTES_PER_SEC,
  DEFAULT_COMPRESSION,
};
