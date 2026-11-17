'use strict';

// 应用侧自动更新（仅 Windows 安装版生效）：
// 查 GitHub Release → 判定 delta 增量包是否适用 → 自动下载（断点续传 + sha256 校验）
// → 用户确认后静默运行安装包并退出。状态经 'ffgui:updater-event' 广播给所有窗口。
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
const EVENT_CHANNEL = 'ffgui:updater-event';
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 自动检查最短间隔：4 小时
const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 30000;
const DOWNLOAD_TIMEOUT_MS = 60000;

// 启动清理：上次下载遗留的增量包 / 全量安装包 / 半成品 / 清单。
// 保留 pending.json 指向的已下载包（「稍后」后下次启动仍提示）。
const STALE_PATTERNS = [
  /^delta-update-.+\.exe$/i,
  /^delta-update-.+\.json$/i,
  /\.partial$/i,
  /^FFGui-.+-Setup\.exe$/i,
];

let initialized = false;
let current = { state: 'none' }; // 最近一次推送的状态（payload 契约见任务说明）
let pending = null; // 已下载待安装：{ version, apply, file }
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
  if (!inDir || !newer || !modeOk || !fs.existsSync(file)) {
    // 已装上（版本不再更新）或文件丢失：标记与残留包都没用了
    try {
      fs.rmSync(pendingMetaPath(), { force: true });
    } catch {
      // 忽略
    }
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
  current = { state: 'downloaded', version: pending.version, apply: pending.apply };
  console.log(`[ffgui] 发现已下载的更新包: ${path.basename(file)}`);
}

function savePending(meta) {
  ensureUpdatesDir();
  try {
    fs.writeFileSync(pendingMetaPath(), JSON.stringify(meta, null, 2), 'utf8');
  } catch (err) {
    console.log(`[ffgui] 保存待安装信息失败: ${err.message}`);
  }
}

// 删除没用的安装包；keepFile 为已下载待安装的包
function cleanupDownloads(keepFile) {
  ensureUpdatesDir();
  const keep = keepFile ? path.resolve(keepFile) : '';
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
    if (keep && path.resolve(full) === keep) continue;
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

// ---------- 下载流程 ----------

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
    await downloadAsset(asset.url, target, onProgress);
    let ok = await verifyFile(target, expectedSha256);
    if (!ok) {
      // 校验失败：删掉重下一次，仍失败才报错
      console.log('[ffgui] 更新包校验失败，重新下载');
      fs.rmSync(target, { force: true });
      await downloadAsset(asset.url, target, onProgress);
      ok = await verifyFile(target, expectedSha256);
      if (!ok) {
        fs.rmSync(target, { force: true });
        throw Object.assign(new Error('更新包校验失败'), { code: 'FFGUI_UPDATE_VERIFY' });
      }
    }
    pending = { version, apply: kind, file: target };
    savePending({ version, apply: kind, file: target });
    activeDownload = null;
    console.log(`[ffgui] 更新包下载完成: ${path.basename(target)}`);
    emit({ state: 'downloaded', version, apply: kind });
  } catch (err) {
    activeDownload = null;
    const code = err && err.code === 'FFGUI_UPDATE_VERIFY'
      ? 'FFGUI_UPDATE_VERIFY'
      : 'FFGUI_UPDATE_NETWORK';
    console.log(`[ffgui] 更新包下载失败: ${err.message}`);
    // 保留 .partial 便于下次检查时带 Range 续传
    emit({ state: 'error', error: code });
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
    let deltaUsable = false;
    if (manifest && normalizeVersion(manifest.version) === latest) {
      deltaUsable = await isDeltaApplicable(manifest, {
        currentVersion: app.getVersion(),
        arch,
        installDir: installDir(),
      });
    }

    if (deltaUsable) {
      const asset = findAsset(assets, manifest.package);
      if (asset) {
        console.log('[ffgui] 增量包适用，开始下载 delta');
        await startDownload({
          version: latest,
          kind: 'delta',
          asset,
          expectedSha256: manifest.packageSha256,
        });
        return current;
      }
      console.log('[ffgui] 清单指向的增量包不存在，改用完整安装包');
    } else {
      console.log('[ffgui] 增量包不适用，改用完整安装包');
    }

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
  let child = null;
  try {
    child = spawn(pending.file, ['/S'], { detached: true, stdio: 'ignore' });
  } catch (err) {
    console.log(`[ffgui] 启动安装程序失败: ${err.message}`);
    emit({ state: 'error', error: 'FFGUI_UPDATE_SPAWN' });
    return current;
  }
  child.on('error', (err) => {
    console.log(`[ffgui] 安装程序启动失败: ${err.message}`);
    emit({ state: 'error', error: 'FFGUI_UPDATE_SPAWN' });
  });
  // 进程真的起来了再退出，避免 spawn 失败后应用已经关掉
  child.once('spawn', () => {
    child.unref();
    console.log('[ffgui] 安装程序已启动，退出应用');
    app.quit();
  });
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
  cleanupDownloads(pending && pending.file);
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
  cleanupDownloads,
  RELEASE_API,
};
