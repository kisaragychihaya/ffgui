'use strict';

// 应用侧自动更新（仅 Windows 安装版生效）：
// 查 GitHub Release → 判定 delta 增量包是否适用 → 自动下载（断点续传 + sha256 校验）
// → 用户确认后静默运行安装包并退出。状态经 'ffgui:updater-event' 广播给所有窗口。
//
// 跨版本时走链式增量：逐个抓取中间各 Release 的 delta 清单，把 fromVersion 首尾相接
// 拼到最新版（任一环节缺失/不符即回退完整安装包）；全部下载后生成 PowerShell 脚本
// 逐跳静默安装（中间跳带 /NORELAUNCH 不拉起应用），脚本最后统一重启应用。
//
// 安装目录取 app.getPath('exe') 所在目录：NSIS 按用户安装到
// %LOCALAPPDATA%\Programs\<产品名>，与卸载注册表项 InstallLocation 指向同一目录。
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const crypto = require('crypto');
const { pipeline } = require('stream');
const { spawn } = require('child_process');

const RELEASE_API = 'https://api.github.com/repos/kisaragychihaya/ffgui/releases/latest';
const RELEASES_API = 'https://api.github.com/repos/kisaragychihaya/ffgui/releases?per_page=100';
const EVENT_CHANNEL = 'ffgui:updater-event';
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 自动检查最短间隔：4 小时
const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 30000;
const DOWNLOAD_TIMEOUT_MS = 60000;
const MAX_CHAIN_HOPS = 8; // 链式增量最多连续跳的版本数，超出回退完整安装包

// 启动清理：上次下载遗留的增量包 / 全量安装包 / 半成品 / 清单 / 链式安装脚本。
// 保留 pending.json 指向的已下载包（「稍后」后下次启动仍提示）。
const STALE_PATTERNS = [
  /^delta-update-.+\.exe$/i,
  /^delta-update-.+\.json$/i,
  /^delta-chain-.+\.ps1$/i,
  /\.partial$/i,
  /^FFGui-.+-Setup\.exe$/i,
];

let initialized = false;
let current = { state: 'none' }; // 最近一次推送的状态（payload 契约见任务说明）
// 已下载待安装：{ version, apply, file }；
// 链式增量另有 files: [{ file, version, fromVersion, sha256 }]（按安装顺序，
// file 恒等于最后一跳的 file，兼容单跳读取逻辑）
let pending = null;
let activeDownload = null; // 下载中的任务，防止重复触发
let checking = false;

function updatesDir() {
  return path.join(app.getPath('userData'), 'updates');
}

function pendingMetaPath() {
  return path.join(updatesDir(), 'pending.json');
}

function lastCheckPath() {
  return path.join(updatesDir(), 'last-check.json');
}

function ensureUpdatesDir() {
  try {
    fs.mkdirSync(updatesDir(), { recursive: true });
  } catch (err) {
    console.log(`[ffgui] 创建更新目录失败: ${err.message}`);
  }
}

function userAgent() {
  try {
    return `FFGui/${app.getVersion()} (Windows updater)`;
  } catch {
    return 'FFGui-Updater';
  }
}

// ---------- 版本比较（纯函数，供测试） ----------

function normalizeVersion(value) {
  return String(value === undefined || value === null ? '' : value)
    .trim()
    .replace(/^v/i, '');
}

// 只取主版本.次版本.修订号做数值比较，附带预发布标识（1.0.0-beta < 1.0.0）
function parseVersion(value) {
  const raw = normalizeVersion(value).split('+')[0];
  const dash = raw.indexOf('-');
  const coreText = dash >= 0 ? raw.slice(0, dash) : raw;
  const preText = dash >= 0 ? raw.slice(dash + 1) : '';
  const nums = coreText.split('.').map((part) => {
    const n = Number.parseInt(part, 10);
    return Number.isFinite(n) ? n : 0;
  });
  while (nums.length < 3) nums.push(0);
  return { core: nums.slice(0, 3), pre: preText ? preText.split('.') : [] };
}

// 返回 -1 / 0 / 1：a 旧于 / 等于 / 新于 b
function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let i = 0; i < 3; i += 1) {
    if (left.core[i] !== right.core[i]) return left.core[i] > right.core[i] ? 1 : -1;
  }
  if (!left.pre.length && !right.pre.length) return 0;
  if (!left.pre.length) return 1; // 正式版高于同号预发布版
  if (!right.pre.length) return -1;
  const len = Math.max(left.pre.length, right.pre.length);
  for (let i = 0; i < len; i += 1) {
    const x = left.pre[i];
    const y = right.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) {
      const dx = Number(x);
      const dy = Number(y);
      if (dx !== dy) return dx > dy ? 1 : -1;
    } else if (xNum) {
      return -1; // 数字标识符低于字母标识符
    } else if (yNum) {
      return 1;
    } else if (x !== y) {
      return x > y ? 1 : -1;
    }
  }
  return 0;
}

// ---------- 文件工具 ----------

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const input = fs.createReadStream(file);
    input.on('error', reject);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('end', () => resolve(hash.digest('hex')));
  });
}

// 安装目录：打包后即 exe 所在目录（NSIS 的 InstallLocation）
function installDir() {
  try {
    return path.dirname(app.getPath('exe'));
  } catch {
    return '';
  }
}

// 清单里的路径必须是安装目录内的相对路径，拒绝绝对路径与 .. 越界
function isSafeRelativePath(rel) {
  if (typeof rel !== 'string' || !rel) return false;
  if (path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) return false;
  const normalized = path.normalize(rel).replace(/\\/g, '/');
  return normalized !== '..' && !normalized.startsWith('../');
}

function isSha256(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
}

// ---------- 状态推送 ----------

function emit(payload) {
  current = payload;
  let windows = [];
  try {
    windows = BrowserWindow.getAllWindows();
  } catch {
    windows = [];
  }
  for (const win of windows) {
    try {
      if (win && !win.isDestroyed()) win.webContents.send(EVENT_CHANNEL, payload);
    } catch (err) {
      console.log(`[ffgui] 推送更新状态失败: ${err.message}`);
    }
  }
}

function getState() {
  return current;
}

// ---------- 上次检查时间（自动检查限频） ----------

function readLastCheck() {
  try {
    const data = JSON.parse(fs.readFileSync(lastCheckPath(), 'utf8'));
    return Number(data && data.checkedAt) || 0;
  } catch {
    return 0;
  }
}

function saveLastCheck(now = Date.now()) {
  ensureUpdatesDir();
  try {
    fs.writeFileSync(lastCheckPath(), JSON.stringify({ checkedAt: now }), 'utf8');
  } catch (err) {
    console.log(`[ffgui] 保存检查时间失败: ${err.message}`);
  }
}

// ---------- 下载目录清理 / 待安装包 ----------

function loadPending() {
  let meta = null;
  try {
    meta = JSON.parse(fs.readFileSync(pendingMetaPath(), 'utf8'));
  } catch {
    return;
  }
  const file = meta && typeof meta.file === 'string' ? path.resolve(meta.file) : '';
  const inDir = file && path.dirname(file) === path.resolve(updatesDir());
  const newer = meta && compareVersions(meta.version, app.getVersion()) > 0;
  const modeOk = meta && (meta.apply === 'delta' || meta.apply === 'full');
  // 链式增量：逐跳校验（路径必须都在更新目录内、文件都在、末跳版本等于目标版本）
  let chain = null;
  if (modeOk && Array.isArray(meta.files) && meta.files.length > 1) {
    chain = [];
    for (const hop of meta.files) {
      const hopFile = hop && typeof hop.file === 'string' ? path.resolve(hop.file) : '';
      const hopOk = hopFile
        && path.dirname(hopFile) === path.resolve(updatesDir())
        && typeof hop.version === 'string'
        && typeof hop.fromVersion === 'string'
        && isSha256(hop.sha256)
        && fs.existsSync(hopFile);
      if (!hopOk) {
        chain = null;
        break;
      }
      chain.push({
        file: hopFile,
        version: hop.version,
        fromVersion: hop.fromVersion,
        sha256: hop.sha256,
      });
    }
    const last = chain && chain[chain.length - 1];
    if (!last || normalizeVersion(last.version) !== normalizeVersion(meta.version) || last.file !== file) {
      chain = null;
    }
  }
  const chainBroken = Array.isArray(meta && meta.files) && meta.files.length > 1 && !chain;
  if (!inDir || !newer || !modeOk || !fs.existsSync(file) || chainBroken) {
    // 已装上（版本不再更新）、文件丢失或链损坏：标记与残留包都没用了
    clearPendingMeta();
    if (inDir) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // 忽略
      }
    }
    return;
  }
  pending = { version: meta.version, apply: meta.apply, file };
  if (chain) pending.files = chain;
  current = { state: 'downloaded', version: pending.version, apply: pending.apply };
  console.log(`[ffgui] 发现已下载的更新包: ${path.basename(file)}`);
}

function clearPendingMeta() {
  try {
    fs.rmSync(pendingMetaPath(), { force: true });
  } catch {
    // 忽略
  }
}

function savePending(meta) {
  ensureUpdatesDir();
  try {
    fs.writeFileSync(pendingMetaPath(), JSON.stringify(meta, null, 2), 'utf8');
  } catch (err) {
    console.log(`[ffgui] 保存待安装信息失败: ${err.message}`);
  }
}

// 删除没用的安装包；keepFiles 为已下载待安装的包（链式增量是一组）
function cleanupDownloads(keepFiles) {
  ensureUpdatesDir();
  const keeps = new Set(
    (Array.isArray(keepFiles) ? keepFiles : [keepFiles])
      .filter(Boolean)
      .map((f) => path.resolve(f)),
  );
  let entries = [];
  try {
    entries = fs.readdirSync(updatesDir());
  } catch (err) {
    console.log(`[ffgui] 读取更新目录失败: ${err.message}`);
    return;
  }
  let removed = 0;
  for (const name of entries) {
    const full = path.join(updatesDir(), name);
    if (keeps.has(path.resolve(full))) continue;
    if (!STALE_PATTERNS.some((re) => re.test(name))) continue;
    try {
      fs.rmSync(full, { force: true });
      removed += 1;
    } catch (err) {
      console.log(`[ffgui] 删除旧更新文件失败 ${name}: ${err.message}`);
    }
  }
  if (removed > 0) console.log(`[ffgui] 已清理 ${removed} 个旧的更新文件`);
}

// pending 指向的全部待安装文件（链式增量为逐跳列表，单跳/全量为单元素）
function pendingFiles() {
  if (!pending) return [];
  if (Array.isArray(pending.files)) return pending.files.map((hop) => hop.file);
  return pending.file ? [pending.file] : [];
}

// ---------- HTTP ----------

function openStream(url, headers, redirects = MAX_REDIRECTS) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (redirects <= 0) {
          reject(new Error('重定向次数过多'));
          return;
        }
        const next = new URL(res.headers.location, url).toString();
        resolve(openStream(next, headers, redirects - 1));
        return;
      }
      resolve(res);
    });
    req.on('error', reject);
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error('请求超时')));
  });
}

function readBody(res, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    res.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        res.destroy(new Error('响应内容过大'));
        return;
      }
      chunks.push(chunk);
    });
    res.on('error', reject);
    res.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

async function fetchJson(url) {
  const res = await openStream(url, {
    'User-Agent': userAgent(),
    Accept: 'application/vnd.github+json, application/json',
  });
  if (res.statusCode !== 200) {
    res.resume();
    throw new Error(`HTTP ${res.statusCode}`);
  }
  const body = await readBody(res);
  return JSON.parse(body.toString('utf8'));
}

// 下载到 target，旁边的 .partial 用于断点续传：
// 已有 .partial 时带 Range 请求，服务端不是 206 就从头写。
async function downloadAsset(url, target, onProgress, attempt = 0) {
  const partial = `${target}.partial`;
  let start = 0;
  try {
    const st = fs.statSync(partial);
    if (st.isFile() && st.size > 0) start = st.size;
  } catch {
    start = 0;
  }
  const headers = { 'User-Agent': userAgent(), Accept: 'application/octet-stream' };
  if (start > 0) headers.Range = `bytes=${start}-`;
  const res = await openStream(url, headers);
  const status = res.statusCode || 0;
  if (status === 416) {
    // 续传区间无效：丢掉半成品从头再来一次
    res.resume();
    if (attempt === 0) {
      try {
        fs.rmSync(partial, { force: true });
      } catch {
        // 忽略
      }
      return downloadAsset(url, target, onProgress, attempt + 1);
    }
    throw new Error('HTTP 416');
  }
  if (status !== 200 && status !== 206) {
    res.resume();
    throw new Error(`HTTP ${status}`);
  }
  const append = status === 206 && start > 0;
  const length = Number(res.headers['content-length']) || 0;
  let base = append ? start : 0;
  let total = length ? base + length : 0;
  if (append) {
    const match = /bytes\s+(\d+)-(\d+)\/(\d+|\*)/i.exec(res.headers['content-range'] || '');
    if (match) {
      const offset = Number(match[1]);
      if (offset !== start && attempt === 0) {
        // 服务端续传起点与本地 .partial 不一致：丢弃半成品重新下载
        res.resume();
        try {
          fs.rmSync(partial, { force: true });
        } catch {
          // 忽略
        }
        return downloadAsset(url, target, onProgress, attempt + 1);
      }
      base = offset;
      const fullSize = match[3] === '*' ? 0 : Number(match[3]);
      total = fullSize || (length ? base + length : 0);
    }
  }

  let received = 0;
  let lastEmit = 0;
  const emitProgress = (force) => {
    if (typeof onProgress !== 'function') return;
    const now = Date.now();
    if (!force && now - lastEmit < 200) return;
    lastEmit = now;
    onProgress(base + received, total || (length ? base + length : 0));
  };

  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(partial, { flags: append ? 'a' : 'w' });
    res.on('data', (chunk) => {
      received += chunk.length;
      emitProgress(false);
    });
    pipeline(res, output, (err) => (err ? reject(err) : resolve()));
  });
  emitProgress(true);

  fs.rmSync(target, { force: true });
  fs.renameSync(partial, target);
  return { size: base + received };
}

async function verifyFile(file, expectedSha256) {
  if (!expectedSha256) return true; // 全量包无哈希可校验
  try {
    const actual = await sha256File(file);
    return actual.toLowerCase() === String(expectedSha256).toLowerCase();
  } catch (err) {
    console.log(`[ffgui] 计算校验值失败: ${err.message}`);
    return false;
  }
}

// ---------- manifest 与 delta 适用性 ----------

async function isDeltaApplicable(manifest, options) {
  const opts = options || {};
  const currentVersion = normalizeVersion(opts.currentVersion);
  const arch = opts.arch;
  const baseDir = opts.installDir;
  const hashFile = opts.hashFile || sha256File;
  if (!manifest || typeof manifest !== 'object') return false;
  if (manifest.schema !== 1) return false;
  // delta 只对「上一版 → 本版」成立：fromVersion 必须是当前安装版本
  if (normalizeVersion(manifest.fromVersion) !== currentVersion) return false;
  if (String(manifest.arch || '') !== String(arch || '')) return false;
  if (!isSafeRelativePath(manifest.package)) return false;
  if (!isSha256(manifest.packageSha256)) return false;
  if (!Array.isArray(manifest.files) || !baseDir) return false;
  for (const entry of manifest.files) {
    if (!entry || typeof entry !== 'object' || !isSafeRelativePath(entry.path)) return false;
    if (typeof entry.method !== 'string') return false;
  }
  const deltas = manifest.files.filter((entry) => entry.method === 'xdelta3');
  for (const entry of deltas) {
    if (!isSha256(entry.sourceSha256)) return false;
    let actual = '';
    try {
      actual = await hashFile(path.join(baseDir, entry.path));
    } catch {
      return false;
    }
    if (String(actual).toLowerCase() !== String(entry.sourceSha256).toLowerCase()) return false;
  }
  return true;
}

function findAsset(assets, name) {
  if (!name) return null;
  const wanted = String(name).toLowerCase();
  const found = (assets || []).find(
    (asset) => asset && typeof asset.name === 'string'
      && asset.name.toLowerCase() === wanted
      && typeof asset.browser_download_url === 'string'
  );
  return found ? { name: path.basename(found.name), url: found.browser_download_url } : null;
}

function findFullAsset(assets, version, arch) {
  const exact = findAsset(assets, `FFGui-${version}-${arch}-Setup.exe`);
  if (exact) return exact;
  // 资产命名有出入时按「FFGui-*-Setup.exe」兜底（仍只下载安装包）
  const any = (assets || []).find(
    (asset) => asset && typeof asset.name === 'string'
      && /^FFGui-.+-Setup\.exe$/i.test(asset.name)
      && typeof asset.browser_download_url === 'string'
  );
  return any ? { name: path.basename(any.name), url: any.browser_download_url } : null;
}

async function loadManifest(assets, version, arch) {
  const asset = findAsset(assets, `delta-update-${version}-${arch}.json`);
  if (!asset) return null;
  try {
    const manifest = await fetchJson(asset.url);
    return manifest && typeof manifest === 'object' ? manifest : null;
  } catch (err) {
    console.log(`[ffgui] 读取增量清单失败: ${err.message}`);
    return null;
  }
}

// 跨版本链式增量解析：从当前版本出发，用各 Release 的 delta 清单把
// fromVersion 首尾相接拼到最新版。任一环节缺失/不符（旧版没有 delta 资产、
// 链条断裂、清单非法、首跳本地文件哈希不符……）都返回 null，调用方回退完整包。
// 只有第一跳能核对本地源文件哈希；后续跳的源文件哈希由 xdelta3 在应用时自验
// （补丁尾部带目标校验和，源不符会解码失败并中断，安装目录停在最后一个一致版本）。
async function resolveDeltaChain(options) {
  const { latest, arch, installDir: baseDir, latestManifest, latestAssets } = options;
  const from = normalizeVersion(options.currentVersion);
  const hopOf = (manifest, assets, fromVersion) => {
    const asset = findAsset(assets, manifest.package);
    return asset ? { version: manifest.version, fromVersion, asset, sha256: manifest.packageSha256 } : null;
  };

  // 最新版没有 delta 清单时链必然拼不成（末跳缺失），不必再拉 Release 列表
  if (!latestManifest) return null;

  // 单跳直达：最新版清单的 fromVersion 就是当前版本
  if (normalizeVersion(latestManifest.version) === latest
    && await isDeltaApplicable(latestManifest, { currentVersion: from, arch, installDir: baseDir })) {
    const hop = hopOf(latestManifest, latestAssets, from);
    return hop ? { hops: [hop] } : null;
  }
  console.log('[ffgui] 最新版增量清单不直抵当前版本，尝试拼跨版本增量链');

  let releases;
  try {
    releases = await fetchJson(RELEASES_API);
  } catch (err) {
    console.log(`[ffgui] 获取 Release 列表失败，无法拼增量链: ${err.message}`);
    return null;
  }
  if (!Array.isArray(releases)) return null;
  const candidates = [];
  for (const rel of releases) {
    if (!rel || rel.draft || rel.prerelease) continue;
    const v = normalizeVersion(rel.tag_name);
    if (!v) continue;
    if (compareVersions(v, from) <= 0 || compareVersions(v, latest) > 0) continue;
    candidates.push({ version: v, assets: Array.isArray(rel.assets) ? rel.assets : [] });
  }
  // 按版本升序走链：每跳取大于当前的最小候选（发布历史是线性的）
  candidates.sort((a, b) => compareVersions(a.version, b.version));

  const hops = [];
  let v = from;
  while (compareVersions(v, latest) < 0) {
    if (hops.length >= MAX_CHAIN_HOPS) {
      console.log(`[ffgui] 增量链超过 ${MAX_CHAIN_HOPS} 跳，回退完整安装包`);
      return null;
    }
    const cand = candidates.find((c) => compareVersions(c.version, v) > 0);
    if (!cand) return null;
    const manifest = cand.version === latest && latestManifest
      ? latestManifest
      : await loadManifest(cand.assets, cand.version, arch);
    if (!manifest || manifest.schema !== 1) return null;
    if (normalizeVersion(manifest.version) !== cand.version) return null;
    if (normalizeVersion(manifest.fromVersion) !== v) return null; // 链条必须严格衔接
    if (String(manifest.arch || '') !== String(arch || '')) return null;
    if (!isSafeRelativePath(manifest.package) || !isSha256(manifest.packageSha256)) return null;
    if (hops.length === 0) {
      const usable = await isDeltaApplicable(manifest, { currentVersion: from, arch, installDir: baseDir });
      if (!usable) return null;
    }
    const hop = hopOf(manifest, cand.assets, v);
    if (!hop) return null;
    hops.push(hop);
    v = cand.version;
  }
  return hops.length ? { hops } : null;
}

// ---------- 下载流程 ----------

// 下载 + sha256 校验（校验失败删包重下一次），返回目标路径；仍失败抛错
async function downloadVerified(asset, expectedSha256, onProgress) {
  const target = path.join(updatesDir(), path.basename(asset.name));
  await downloadAsset(asset.url, target, onProgress);
  let ok = await verifyFile(target, expectedSha256);
  if (!ok) {
    console.log('[ffgui] 更新包校验失败，重新下载');
    fs.rmSync(target, { force: true });
    await downloadAsset(asset.url, target, onProgress);
    ok = await verifyFile(target, expectedSha256);
    if (!ok) {
      fs.rmSync(target, { force: true });
      throw Object.assign(new Error('更新包校验失败'), { code: 'FFGUI_UPDATE_VERIFY' });
    }
  }
  return target;
}

function downloadFailed(err) {
  activeDownload = null;
  const code = err && err.code === 'FFGUI_UPDATE_VERIFY'
    ? 'FFGUI_UPDATE_VERIFY'
    : 'FFGUI_UPDATE_NETWORK';
  console.log(`[ffgui] 更新包下载失败: ${err.message}`);
  // 保留 .partial 便于下次检查时带 Range 续传
  emit({ state: 'error', error: code });
}

async function startDownload({ version, kind, asset, expectedSha256 }) {
  ensureUpdatesDir();
  const target = path.join(updatesDir(), path.basename(asset.name));
  activeDownload = { version, kind, target };
  const onProgress = (bytes, total) => {
    const progress = total > 0 ? Math.min(1, bytes / total) : 0;
    emit({
      state: 'downloading',
      version,
      apply: kind,
      progress: Number(progress.toFixed(4)),
    });
  };
  emit({ state: 'downloading', version, apply: kind, progress: 0 });
  try {
    await downloadVerified(asset, expectedSha256, onProgress);
    pending = { version, apply: kind, file: target };
    savePending({ version, apply: kind, file: target });
    activeDownload = null;
    console.log(`[ffgui] 更新包下载完成: ${path.basename(target)}`);
    emit({ state: 'downloaded', version, apply: kind });
  } catch (err) {
    downloadFailed(err);
  }
}

// 链式增量：逐跳下载校验，进度按跳数均摊；全部就绪后一次性写入 pending
async function startChainDownload({ version, hops }) {
  ensureUpdatesDir();
  activeDownload = { version, kind: 'delta', target: '' };
  emit({ state: 'downloading', version, apply: 'delta', progress: 0 });
  const files = [];
  try {
    for (let i = 0; i < hops.length; i += 1) {
      const hop = hops[i];
      const onProgress = (bytes, total) => {
        const part = total > 0 ? Math.min(1, bytes / total) : 0;
        const progress = (i + part) / hops.length;
        emit({
          state: 'downloading',
          version,
          apply: 'delta',
          progress: Number(progress.toFixed(4)),
        });
      };
      const target = await downloadVerified(hop.asset, hop.sha256, onProgress);
      files.push({
        file: target,
        version: hop.version,
        fromVersion: hop.fromVersion,
        sha256: hop.sha256,
      });
    }
    pending = { version, apply: 'delta', file: files[files.length - 1].file, files };
    savePending(pending);
    activeDownload = null;
    console.log(`[ffgui] 链式增量包下载完成：${files.length} 跳，目标 ${version}`);
    emit({ state: 'downloaded', version, apply: 'delta' });
  } catch (err) {
    downloadFailed(err);
  }
}

// ---------- 检查更新 ----------

async function checkForUpdates(manual = false) {
  if (process.platform !== 'win32' || !app.isPackaged) return current;
  if (checking || activeDownload) return current;
  if (pending) return current; // 已有待安装包，先让用户装
  if (!manual) {
    const last = readLastCheck();
    if (last && Date.now() - last < CHECK_INTERVAL_MS) {
      console.log('[ffgui] 距上次检查更新不足 4 小时，跳过本次自动检查');
      return current;
    }
  }

  checking = true;
  emit({ state: 'checking' });
  try {
    const release = await fetchJson(RELEASE_API);
    const latest = normalizeVersion(release && release.tag_name);
    saveLastCheck();
    if (!latest) throw new Error('Release 缺少 tag_name');
    if (compareVersions(latest, app.getVersion()) <= 0) {
      console.log(`[ffgui] 已是最新版本 ${app.getVersion()}`);
      emit({ state: 'none' });
      return current;
    }
    console.log(`[ffgui] 发现新版本 ${latest}（当前 ${app.getVersion()}）`);
    emit({ state: 'available', version: latest });

    const arch = process.arch;
    const assets = Array.isArray(release.assets) ? release.assets : [];
    const manifest = await loadManifest(assets, latest, arch);
    const chain = await resolveDeltaChain({
      latest,
      arch,
      currentVersion: app.getVersion(),
      installDir: installDir(),
      latestManifest: manifest,
      latestAssets: assets,
    });

    if (chain && chain.hops.length === 1) {
      console.log('[ffgui] 增量包适用，开始下载 delta');
      const hop = chain.hops[0];
      await startDownload({ version: latest, kind: 'delta', asset: hop.asset, expectedSha256: hop.sha256 });
      return current;
    }
    if (chain) {
      console.log(`[ffgui] 跨版本链式增量：${app.getVersion()} -> ${chain.hops.map((h) => h.version).join(' -> ')}`);
      await startChainDownload({ version: latest, hops: chain.hops });
      return current;
    }
    console.log('[ffgui] 增量包不适用，改用完整安装包');

    const fullName = manifest && typeof manifest.fullSetup === 'string' ? manifest.fullSetup : '';
    const fullAsset = findAsset(assets, fullName) || findFullAsset(assets, latest, arch);
    if (!fullAsset) throw new Error('Release 中没有可用的安装包');
    console.log(`[ffgui] 完整安装包: ${fullAsset.name}`);
    await startDownload({ version: latest, kind: 'full', asset: fullAsset, expectedSha256: null });
    return current;
  } catch (err) {
    console.log(`[ffgui] 检查更新失败: ${err.message}`);
    // 自动检查失败不打扰用户（只记日志）；手动检查要给出错误
    if (manual) emit({ state: 'error', error: 'FFGUI_UPDATE_NETWORK' });
    else if (current.state !== 'downloading') emit({ state: 'none' });
    return current;
  } finally {
    checking = false;
  }
}

// ---------- 安装 ----------

// 启动安装进程，确认起来后再退出应用（避免 spawn 失败但应用已关）
function spawnAndQuit(file, args, extraOptions) {
  let child = null;
  try {
    child = spawn(file, args, { detached: true, stdio: 'ignore', ...(extraOptions || {}) });
  } catch (err) {
    console.log(`[ffgui] 启动安装程序失败: ${err.message}`);
    emit({ state: 'error', error: 'FFGUI_UPDATE_SPAWN' });
    return;
  }
  child.on('error', (err) => {
    console.log(`[ffgui] 安装程序启动失败: ${err.message}`);
    emit({ state: 'error', error: 'FFGUI_UPDATE_SPAWN' });
  });
  child.once('spawn', () => {
    child.unref();
    console.log('[ffgui] 安装程序已启动，退出应用');
    app.quit();
  });
}

// PowerShell 单引号字符串转义
function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

// 链式安装脚本：逐跳静默安装，全部带 /NORELAUNCH（由脚本统一编排，中间版本
// 不得启动——它的更新器会与链竞争）；任一跳退出码非 0 即中断，应用停在最后一个
// 一致版本；全部成功后脚本拉起应用本身
function buildChainScript(hops, exePath) {
  const lines = ["$ErrorActionPreference = 'Stop'"];
  for (const hop of hops) {
    lines.push(`$p = Start-Process -FilePath ${psQuote(hop.file)} -ArgumentList '/S','/NORELAUNCH' -Wait -PassThru`);
    lines.push('if ($p.ExitCode -ne 0) { exit $p.ExitCode }');
  }
  lines.push(`Start-Process -FilePath ${psQuote(exePath)}`);
  lines.push('exit 0');
  return `${lines.join('\r\n')}\r\n`;
}

// 生成链式安装脚本，返回脚本路径；链与当前版本对不上（如上次中断后续装失败）
// 或文件缺失时作废 pending 并返回 ''。脚本以带 BOM 的 UTF-8 写入：路径含中文
// （更新目录在 %APPDATA%\<产品名> 下），无 BOM 时 Windows PowerShell 按 ANSI 解析会乱码
function prepareChainScript() {
  const currentVersion = normalizeVersion(app.getVersion());
  // 断链续装：跳过已装上的跳（上次安装中断后重进，剩余链必须正好从当前版本出发）
  const remaining = pending.files.filter((hop) => compareVersions(hop.version, currentVersion) > 0);
  const first = remaining[0];
  const broken = !first
    || normalizeVersion(first.fromVersion) !== currentVersion
    || remaining.some((hop) => !fs.existsSync(hop.file));
  if (broken) {
    console.log('[ffgui] 增量链与当前版本不匹配或文件缺失，作废待安装包');
    pending = null;
    clearPendingMeta();
    emit({ state: 'error', error: 'FFGUI_UPDATE_CHAIN' });
    return '';
  }
  const scriptPath = path.join(updatesDir(), `delta-chain-${pending.version}.ps1`);
  try {
    fs.writeFileSync(scriptPath, '﻿' + buildChainScript(remaining, app.getPath('exe')), 'utf8');
  } catch (err) {
    console.log(`[ffgui] 写入链式安装脚本失败: ${err.message}`);
    emit({ state: 'error', error: 'FFGUI_UPDATE_SPAWN' });
    return '';
  }
  return scriptPath;
}

function applyUpdate() {
  if (!pending || !pending.file || !fs.existsSync(pending.file)) {
    console.log('[ffgui] 没有已下载的更新包，无法安装');
    return current;
  }
  let taskgate = null;
  try {
    taskgate = require('./taskgate');
  } catch (err) {
    console.log(`[ffgui] 读取任务状态失败: ${err.message}`);
  }
  if (taskgate && taskgate.isBusy()) {
    console.log('[ffgui] 有任务正在执行，暂不安装更新');
    emit({ state: 'error', error: 'FFGUI_UPDATE_BUSY' });
    return current;
  }

  emit({ state: 'applying', version: pending.version, apply: pending.apply });
  // 链式增量：脚本逐跳安装；单跳 delta / 全量包：直接静默运行安装包
  if (pending.apply === 'delta' && Array.isArray(pending.files) && pending.files.length > 1) {
    const scriptPath = prepareChainScript();
    if (scriptPath) {
      spawnAndQuit('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
      ], { windowsHide: true });
    }
    return current;
  }
  spawnAndQuit(pending.file, ['/S']);
  return current;
}

// ---------- 初始化与 IPC ----------

function registerUpdaterIpc() {
  ipcMain.handle('ffgui:updater-check', async () => {
    await checkForUpdates(true);
    return current;
  });
  ipcMain.handle('ffgui:updater-state', () => current);
  ipcMain.handle('ffgui:updater-apply', () => applyUpdate());
}

function init() {
  if (initialized) return;
  if (process.platform !== 'win32' || !app.isPackaged) {
    console.log('[ffgui] 自动更新仅在 Windows 安装版启用，跳过');
    return;
  }
  initialized = true;
  ensureUpdatesDir();
  loadPending();
  cleanupDownloads(pendingFiles());
  registerUpdaterIpc();
  checkForUpdates(false).catch((err) => {
    console.log(`[ffgui] 自动检查更新失败: ${err.message}`);
  });
}

module.exports = {
  init,
  registerUpdaterIpc,
  checkForUpdates,
  applyUpdate,
  getState,
  normalizeVersion,
  compareVersions,
  isDeltaApplicable,
  resolveDeltaChain,
  buildChainScript,
  cleanupDownloads,
  RELEASE_API,
  RELEASES_API,
  MAX_CHAIN_HOPS,
};
