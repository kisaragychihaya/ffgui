'use strict';

// 运行：node --test scripts/updater.test.cjs
// 应用自动更新（main/updater.js）测试：用 vm + mock electron 加载，https / spawn /
// './taskgate' 全部注入桩，不 require 真实 electron、不联网、不启动真实安装程序。
// 断言导出契约（版本比较 / delta 适用性）与可观察行为（Range 续传、sha256 校验
// 失败重试、4 小时限频、启动清理、apply 的错误码、状态事件 payload）。

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');

const repo = path.resolve(__dirname, '..');
const UPDATER_SOURCE = fs.readFileSync(path.join(repo, 'main', 'updater.js'), 'utf8');
const RELEASE_API = 'https://api.github.com/repos/kisaragychihaya/ffgui/releases/latest';
const RELEASES_API = 'https://api.github.com/repos/kisaragychihaya/ffgui/releases?per_page=100';

const ALLOWED_STATES = new Set([
  'none', 'checking', 'available', 'downloading', 'downloaded', 'applying', 'error',
]);

const tempRoots = [];
after(() => {
  for (const dir of tempRoots) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix = 'ffgui-updater-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function asset(name, url) {
  return { name, browser_download_url: url };
}

// ---------- https / 响应桩 ----------

// 假 https.get：handler(record, cb) 决定回什么。record 记住请求地址与请求头。
function fakeHttps(handler) {
  const calls = [];
  return {
    calls,
    get(url, options, cb) {
      const req = new EventEmitter();
      req.setTimeout = () => req;
      req.destroy = (err) => {
        req.destroyedWith = err;
      };
      const record = { url, headers: (options && options.headers) || {} };
      calls.push(record);
      setImmediate(() => handler(record, cb));
      return req;
    },
  };
}

function fakeResponse({ statusCode = 200, headers = {}, body = '' } = {}) {
  const stream = Readable.from(body === '' ? [] : [Buffer.from(body)]);
  stream.statusCode = statusCode;
  stream.headers = headers;
  return stream;
}

function releaseBody(version, assets) {
  return JSON.stringify({ tag_name: `v${version}`, assets });
}

// ---------- vm 加载 ----------

function loadUpdater(options = {}) {
  const root = options.root || tempDir();
  const userData = path.join(root, 'userData');
  const installDir = options.installDir || path.join(root, 'install');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(installDir, { recursive: true });

  const events = [];
  const windows = options.noWindow ? [] : [{
    isDestroyed: () => false,
    webContents: {
      send: (channel, payload) => {
        assert.equal(channel, 'ffgui:updater-event');
        events.push(payload);
      },
    },
  }];
  let quitCalls = 0;
  const app = {
    isPackaged: options.isPackaged !== false,
    getVersion: () => options.currentVersion || '0.7.4',
    getPath: (name) => {
      if (name === 'userData') return userData;
      if (name === 'exe') return path.join(installDir, 'FFGui.exe');
      return root;
    },
    quit: () => {
      quitCalls += 1;
    },
  };
  const handlers = new Map();
  const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler) };
  const busyRef = { value: Boolean(options.busy) };
  const taskgate = { isBusy: () => busyRef.value };
  const spawnCalls = [];
  const spawn = options.spawn || ((cmd, args, spawnOptions) => {
    const child = new EventEmitter();
    child.unref = () => {
      child.unrefCalled = true;
    };
    spawnCalls.push({ cmd, args, spawnOptions, child });
    setImmediate(() => child.emit('spawn'));
    return child;
  });
  const https = options.https || fakeHttps((record, cb) => cb(fakeResponse({ statusCode: 404 })));

  const ctx = {
    require: (name) => {
      if (name === 'electron') {
        return { app, BrowserWindow: { getAllWindows: () => windows }, ipcMain };
      }
      if (name === 'https') return https;
      if (name === 'child_process') return { spawn };
      if (name === './taskgate') return taskgate;
      return require(name);
    },
    // 默认强制 win32：自动更新只在 Windows 安装版执行，测试机可能是 macOS/Linux
    process: { platform: options.platform || 'win32', arch: options.arch || 'x64' },
    console: { log() {}, error() {} },
    module: { exports: {} },
    __dirname: path.join(repo, 'main'),
    Buffer,
    URL,
    setTimeout,
    clearTimeout,
    setImmediate,
  };
  vm.createContext(ctx);
  vm.runInContext(UPDATER_SOURCE, ctx);

  return {
    root,
    userData,
    installDir,
    updatesDir: path.join(userData, 'updates'),
    api: ctx.module.exports,
    app,
    events,
    handlers,
    https,
    spawnCalls,
    quitCalls: () => quitCalls,
    setBusy: (value) => {
      busyRef.value = value;
    },
    states: () => events.map((event) => event.state),
    lastEvent: () => events[events.length - 1],
  };
}

// 每个推送都必须满足的 payload 契约
function assertPayloadContract(event) {
  assert.ok(ALLOWED_STATES.has(event.state), `未知状态：${event.state}`);
  if (['downloading', 'downloaded', 'applying'].includes(event.state)) {
    assert.ok(
      event.apply === 'delta' || event.apply === 'full',
      `apply 只能是 delta/full：${JSON.stringify(event.apply)}`,
    );
  }
  if (event.state === 'downloading') {
    assert.equal(typeof event.progress, 'number');
    assert.ok(event.progress >= 0 && event.progress <= 1, `progress 越界：${event.progress}`);
  }
  if (event.state === 'error') {
    assert.match(event.error, /^FFGUI_UPDATE_/);
  }
}

function assertAllPayloads(events) {
  for (const event of events) assertPayloadContract(event);
}

// 生成一份「对当前安装目录适用」的 delta 清单，并写好被补丁的源文件
function makeDeltaManifest(installDir, overrides = {}) {
  const sourcePath = path.join(installDir, 'resources', 'app.asar');
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  const source = Buffer.from('old-app-asar');
  fs.writeFileSync(sourcePath, source);
  return {
    schema: 1,
    version: '0.8.0',
    fromVersion: '0.7.4',
    arch: 'x64',
    package: 'delta-update-0.8.0-x64.exe',
    packageSha256: 'a'.repeat(64),
    fullSetup: 'FFGui-0.8.0-x64-Setup.exe',
    files: [
      { path: 'resources/app.asar', method: 'xdelta3', sourceSha256: sha256(source) },
      { path: 'resources/added.js', method: 'copy' },
    ],
    removed: [],
    ...overrides,
  };
}

// 完整的 delta Release：清单资产 + 增量包 + 全量包（仅用于回退断言）
function deltaReleaseHttps(manifest, deltaBody, fullBody = 'full-setup') {
  const deltaRequests = [];
  const fullRequests = [];
  const releaseAssets = [
    asset(`delta-update-${manifest.version}-${manifest.arch}.json`, 'https://dl.example.com/manifest.json'),
    asset(manifest.package, 'https://dl.example.com/delta.exe'),
    asset(manifest.fullSetup, 'https://dl.example.com/full.exe'),
  ];
  const https = fakeHttps((record, cb) => {
    if (record.url === RELEASE_API) {
      cb(fakeResponse({
        statusCode: 200,
        body: releaseBody(manifest.version, releaseAssets),
      }));
      return;
    }
    if (record.url === RELEASES_API) {
      // 跨版本拼链时的列表请求：只回最新版自身（链拼不成则回退全量）
      cb(fakeResponse({
        statusCode: 200,
        body: JSON.stringify([{ tag_name: `v${manifest.version}`, assets: releaseAssets }]),
      }));
      return;
    }
    if (record.url.endsWith('/manifest.json')) {
      cb(fakeResponse({ statusCode: 200, body: JSON.stringify(manifest) }));
      return;
    }
    if (record.url.endsWith('/delta.exe')) {
      deltaRequests.push(record);
      cb(fakeResponse({
        statusCode: 200,
        headers: { 'content-length': String(Buffer.byteLength(deltaBody)) },
        body: deltaBody,
      }));
      return;
    }
    fullRequests.push(record);
    cb(fakeResponse({
      statusCode: 200,
      headers: { 'content-length': String(Buffer.byteLength(fullBody)) },
      body: fullBody,
    }));
  });
  return { https, deltaRequests, fullRequests };
}

// 纯全量更新：Release 里只有一个安装包资产
function fullReleaseHttps({ version = '0.8.0', setupName = 'FFGui-0.8.0-x64-Setup.exe', onAsset }) {
  const assetRequests = [];
  const https = fakeHttps((record, cb) => {
    if (record.url === RELEASE_API) {
      cb(fakeResponse({
        statusCode: 200,
        body: releaseBody(version, [asset(setupName, 'https://dl.example.com/setup.exe')]),
      }));
      return;
    }
    assetRequests.push(record);
    onAsset(record, cb, assetRequests.length);
  });
  return { https, assetRequests };
}

// ---------- 版本比较 ----------

test('semver 比较：三段数值、v 前缀、预发布与构建元数据', () => {
  const { api } = loadUpdater();
  assert.equal(api.normalizeVersion('  v0.7.4 '), '0.7.4');
  assert.equal(api.normalizeVersion('0.7.4'), '0.7.4');
  assert.equal(api.normalizeVersion(undefined), '');

  assert.equal(api.compareVersions('0.7.4', '0.7.4'), 0);
  assert.equal(api.compareVersions('v0.7.4', '0.7.4'), 0);
  assert.equal(api.compareVersions('1', '1.0.0'), 0);
  assert.equal(api.compareVersions('0.7.10', '0.7.9'), 1);
  assert.equal(api.compareVersions('0.8.0', '0.7.99'), 1);
  assert.equal(api.compareVersions('10.0.0', '9.9.9'), 1);
  assert.equal(api.compareVersions('1.0.0+build.5', '1.0.0'), 0);

  // 预发布低于同号正式版，标识符逐段比较
  assert.equal(api.compareVersions('1.0.0-beta', '1.0.0'), -1);
  assert.equal(api.compareVersions('1.0.0', '1.0.0-beta'), 1);
  assert.equal(api.compareVersions('1.0.0-beta.2', '1.0.0-beta.10'), -1);
  assert.equal(api.compareVersions('1.0.0-beta', '1.0.0-alpha'), 1);
  assert.equal(api.compareVersions('1.0.0-alpha', '1.0.0-alpha.1'), -1);
  // 数字标识符低于字母标识符
  assert.equal(api.compareVersions('1.0.0-1', '1.0.0-alpha'), -1);
  assert.equal(api.compareVersions('1.0.0-alpha', '1.0.0-1'), 1);
  // 非数字段按 0 处理，不抛错
  assert.equal(api.compareVersions('0.x.0', '0.0.0'), 0);
});

// ---------- delta 适用性 ----------

test('delta 适用性：版本 / 架构 / 路径 / 哈希全部匹配才可用', async () => {
  const h = loadUpdater();
  const manifest = makeDeltaManifest(h.installDir);
  assert.equal(await h.api.isDeltaApplicable(manifest, {
    currentVersion: 'v0.7.4'.replace('v', ''), // 与 app.getVersion() 形态一致
    arch: 'x64',
    installDir: h.installDir,
  }), true);
  // 当前版本带 v 前缀也能归一
  assert.equal(await h.api.isDeltaApplicable(manifest, {
    currentVersion: 'v0.7.4',
    arch: 'x64',
    installDir: h.installDir,
  }), true);
  // copy 条目不需要 sourceSha256
  assert.equal(await h.api.isDeltaApplicable({
    ...manifest,
    files: [{ path: 'resources/added.js', method: 'copy' }],
  }, { currentVersion: '0.7.4', arch: 'x64', installDir: h.installDir }), true);
});

test('delta 适用性：任一条件不满足即拒绝（调用方回退 full）', async () => {
  const h = loadUpdater();
  const base = makeDeltaManifest(h.installDir);
  const opts = { currentVersion: '0.7.4', arch: 'x64', installDir: h.installDir };

  const cases = [
    ['manifest 为空', null],
    ['schema 不是 1', { schema: 2 }],
    ['fromVersion 与当前版本不同', { fromVersion: '0.7.3' }],
    ['arch 不匹配', { arch: 'arm64' }],
    ['package 是绝对路径', { package: 'C:\\evil\\delta.exe' }],
    ['package 越过更新目录', { package: '../delta.exe' }],
    ['packageSha256 格式非法', { packageSha256: 'not-a-sha256' }],
    ['files 不是数组', { files: 'nope' }],
    ['补丁条目缺 sourceSha256', {
      files: [{ path: 'resources/app.asar', method: 'xdelta3' }],
    }],
    ['补丁条目路径越界', {
      files: [{ path: '../app.asar', method: 'xdelta3', sourceSha256: 'b'.repeat(64) }],
    }],
    ['本地源文件不存在', {
      files: [{ path: 'resources/missing.bin', method: 'xdelta3', sourceSha256: 'b'.repeat(64) }],
    }],
    ['本地源文件哈希不一致', {
      files: [{ path: 'resources/app.asar', method: 'xdelta3', sourceSha256: 'b'.repeat(64) }],
    }],
  ];

  for (const [label, patch] of cases) {
    const manifest = patch === null ? null : { ...base, ...patch };
    assert.equal(await h.api.isDeltaApplicable(manifest, opts), false, label);
  }

  // 拿不到安装目录时无法核对源文件哈希
  assert.equal(await h.api.isDeltaApplicable(base, { ...opts, installDir: '' }), false);
  // 哈希函数抛错按不适用处理
  assert.equal(await h.api.isDeltaApplicable(base, {
    ...opts,
    hashFile: async () => {
      throw new Error('读取失败');
    },
  }), false);
});

// ---------- 下载：Range 断点续传 ----------

test('Range 续传：已有 .partial 时带 Range，206 追加写入并改名', async () => {
  const targetName = 'FFGui-0.8.0-x64-Setup.exe';
  const { https, assetRequests } = fullReleaseHttps({
    onAsset: (record, cb) => {
      assert.equal(record.headers.Range, 'bytes=4-');
      cb(fakeResponse({
        statusCode: 206,
        headers: { 'content-length': '6', 'content-range': 'bytes 4-9/10' },
        body: 'TAIL!!',
      }));
    },
  });
  const h = loadUpdater({ https });
  fs.mkdirSync(h.updatesDir, { recursive: true });
  const target = path.join(h.updatesDir, targetName);
  fs.writeFileSync(`${target}.partial`, 'HEAD');

  await h.api.checkForUpdates(true);

  assert.equal(assetRequests.length, 1);
  assert.equal(fs.readFileSync(target, 'utf8'), 'HEADTAIL!!');
  assert.equal(fs.existsSync(`${target}.partial`), false, '完成后 .partial 必须改名消失');
  assert.equal(h.api.getState().state, 'downloaded');
  assert.equal(h.api.getState().apply, 'full');

  assertAllPayloads(h.events);
  const downloading = h.events.filter((event) => event.state === 'downloading');
  assert.ok(downloading.length >= 2, '至少要有起始与结束两次进度');
  assert.equal(downloading[0].progress, 0);
  assert.equal(downloading[downloading.length - 1].progress, 1);
  assert.equal(h.events.find((event) => event.state === 'downloaded').version, '0.8.0');
});

test('Range 续传：服务端忽略 Range 回 200 时从头覆盖 .partial', async () => {
  const targetName = 'FFGui-0.8.0-x64-Setup.exe';
  const { https, assetRequests } = fullReleaseHttps({
    onAsset: (record, cb) => {
      // 请求确实带了 Range，但服务端不认，回 200 全量
      assert.equal(record.headers.Range, 'bytes=5-');
      cb(fakeResponse({ statusCode: 200, headers: { 'content-length': '5' }, body: 'FRESH' }));
    },
  });
  const h = loadUpdater({ https });
  fs.mkdirSync(h.updatesDir, { recursive: true });
  const target = path.join(h.updatesDir, targetName);
  fs.writeFileSync(`${target}.partial`, 'STALE');

  await h.api.checkForUpdates(true);

  assert.equal(assetRequests.length, 1);
  assert.equal(fs.readFileSync(target, 'utf8'), 'FRESH', '200 必须从零写，不能把半成品拼进去');
  assert.equal(fs.existsSync(`${target}.partial`), false);
  assert.equal(h.api.getState().state, 'downloaded');
});

test('Range 续传：416 时丢弃半成品并重试一次（第二次不带 Range）', async () => {
  const targetName = 'FFGui-0.8.0-x64-Setup.exe';
  const { https, assetRequests } = fullReleaseHttps({
    onAsset: (record, cb, index) => {
      if (index === 1) {
        cb(fakeResponse({ statusCode: 416 }));
        return;
      }
      assert.equal(record.headers.Range, undefined, '丢弃 .partial 后不能再请求续传区间');
      cb(fakeResponse({ statusCode: 200, headers: { 'content-length': '2' }, body: 'OK' }));
    },
  });
  const h = loadUpdater({ https });
  fs.mkdirSync(h.updatesDir, { recursive: true });
  const target = path.join(h.updatesDir, targetName);
  fs.writeFileSync(`${target}.partial`, 'STALE');

  await h.api.checkForUpdates(true);

  assert.equal(assetRequests.length, 2);
  assert.equal(fs.readFileSync(target, 'utf8'), 'OK');
  assert.equal(h.api.getState().state, 'downloaded');
});

// ---------- 下载：sha256 校验 ----------

test('校验失败：删包重下一次，仍不一致报 FFGUI_UPDATE_VERIFY', async () => {
  const root = tempDir();
  const installDir = path.join(root, 'install');
  fs.mkdirSync(installDir, { recursive: true });
  const manifest = makeDeltaManifest(installDir, {
    // 格式合法但与下载内容不一致
    packageSha256: sha256('expected-package-bytes'),
  });
  const { https, deltaRequests, fullRequests } = deltaReleaseHttps(manifest, 'actual-package-bytes');
  const h = loadUpdater({ https, root, installDir });

  await h.api.checkForUpdates(true);

  assert.equal(deltaRequests.length, 2, '校验失败必须重下一次');
  assert.equal(fullRequests.length, 0, '重试的仍是 delta，不应改用 full');
  const last = h.lastEvent();
  assert.equal(last.state, 'error');
  assert.equal(last.error, 'FFGUI_UPDATE_VERIFY');
  assert.equal(h.api.getState().error, 'FFGUI_UPDATE_VERIFY');
  assert.equal(fs.existsSync(path.join(h.updatesDir, manifest.package)), false);
  assert.equal(fs.existsSync(path.join(h.updatesDir, 'pending.json')), false);
  assertAllPayloads(h.events);
});

test('delta 下载成功：sha256 匹配后进入 downloaded 并写入 pending.json', async () => {
  const root = tempDir();
  const installDir = path.join(root, 'install');
  fs.mkdirSync(installDir, { recursive: true });
  const body = 'delta-package-bytes';
  const manifest = makeDeltaManifest(installDir, { packageSha256: sha256(body) });
  const { https, deltaRequests, fullRequests } = deltaReleaseHttps(manifest, body);
  const h = loadUpdater({ https, root, installDir });

  await h.api.checkForUpdates(true);

  assert.equal(deltaRequests.length, 1);
  assert.equal(fullRequests.length, 0);
  const state = h.api.getState();
  assert.equal(state.state, 'downloaded');
  assert.equal(state.version, '0.8.0');
  assert.equal(state.apply, 'delta');
  assert.equal(fs.readFileSync(path.join(h.updatesDir, manifest.package), 'utf8'), body);

  const pending = JSON.parse(fs.readFileSync(path.join(h.updatesDir, 'pending.json'), 'utf8'));
  assert.equal(pending.version, '0.8.0');
  assert.equal(pending.apply, 'delta');
  assert.equal(pending.file, path.join(h.updatesDir, manifest.package));
  assertAllPayloads(h.events);
  const available = h.events.find((event) => event.state === 'available');
  assert.equal(available.version, '0.8.0');
});

// ---------- 自动检查限频 ----------

test('4 小时限频：窗口内自动检查跳过，超窗或手动检查放行', async () => {
  const calls = [];
  const https = fakeHttps((record, cb) => {
    calls.push(record);
    cb(fakeResponse({
      statusCode: 200,
      // 最新版本与当前一致 -> 不下载
      body: releaseBody('0.7.4', []),
    }));
  });
  const h = loadUpdater({ https });
  fs.mkdirSync(h.updatesDir, { recursive: true });
  const lastCheck = path.join(h.updatesDir, 'last-check.json');
  fs.writeFileSync(lastCheck, JSON.stringify({ checkedAt: Date.now() - 60 * 1000 }));

  // 1) 窗口内自动检查：不联网、不推事件，状态保持 none
  await h.api.checkForUpdates(false);
  assert.equal(calls.length, 0);
  assert.equal(h.events.length, 0);
  assert.equal(h.api.getState().state, 'none');

  // 2) 手动检查无视限频
  await h.api.checkForUpdates(true);
  assert.equal(calls.length, 1);
  assert.deepEqual(h.states(), ['checking', 'none']);
  const saved = JSON.parse(fs.readFileSync(lastCheck, 'utf8'));
  assert.ok(Date.now() - saved.checkedAt < 60 * 1000, '检查成功后要刷新时间戳');

  // 3) 超过 4 小时后自动检查放行
  fs.writeFileSync(lastCheck, JSON.stringify({
    checkedAt: Date.now() - (4 * 60 * 60 * 1000 + 60 * 1000),
  }));
  await h.api.checkForUpdates(false);
  assert.equal(calls.length, 2);
  assert.deepEqual(h.states(), ['checking', 'none', 'checking', 'none']);
  assertAllPayloads(h.events);
});

test('检查失败：自动检查只记日志，手动检查才推送 FFGUI_UPDATE_NETWORK', async () => {
  const https = fakeHttps((record, cb) => cb(fakeResponse({ statusCode: 503 })));

  const auto = loadUpdater({ https });
  fs.mkdirSync(auto.updatesDir, { recursive: true });
  await auto.api.checkForUpdates(false);
  // 自动检查不打扰用户：checking -> none，没有 error
  assert.deepEqual(auto.states(), ['checking', 'none']);

  const manual = loadUpdater({ https });
  await manual.api.checkForUpdates(true);
  assert.deepEqual(manual.states(), ['checking', 'error']);
  assert.equal(manual.lastEvent().error, 'FFGUI_UPDATE_NETWORK');
});

// ---------- 启动清理 ----------

test('启动清理：保留 pending.json 指向的包，删除其余旧包与半成品', () => {
  const h = loadUpdater();
  fs.mkdirSync(h.updatesDir, { recursive: true });
  const keep = path.join(h.updatesDir, 'delta-update-0.8.0-x64.exe');
  const stale = [
    'delta-update-0.7.4-x64.exe',
    'delta-update-0.7.4-x64.json',
    'FFGui-0.8.0-x64-Setup.exe',
    'FFGui-0.8.0-x64-Setup.exe.partial',
    'random.partial',
  ];
  const untouched = ['notes.txt', 'last-check.json'];
  fs.writeFileSync(keep, 'keep-me');
  for (const name of stale) fs.writeFileSync(path.join(h.updatesDir, name), 'stale');
  for (const name of untouched) fs.writeFileSync(path.join(h.updatesDir, name), '{}');
  fs.writeFileSync(path.join(h.updatesDir, 'pending.json'), JSON.stringify({
    version: '0.8.0', apply: 'delta', file: keep,
  }));
  // 限频窗口内的检查时间戳，避免 init 内自动检查真的联网
  fs.writeFileSync(path.join(h.updatesDir, 'last-check.json'), JSON.stringify({ checkedAt: Date.now() }));

  h.api.init();

  assert.equal(fs.existsSync(keep), true, '待安装的包必须保留');
  assert.equal(fs.existsSync(path.join(h.updatesDir, 'pending.json')), true);
  for (const name of stale) {
    assert.equal(fs.existsSync(path.join(h.updatesDir, name)), false, `${name} 应被清理`);
  }
  for (const name of untouched) {
    assert.equal(fs.existsSync(path.join(h.updatesDir, name)), true, `${name} 不在清理规则内`);
  }
  const state = h.api.getState();
  assert.equal(state.state, 'downloaded');
  assert.equal(state.version, '0.8.0');
  assert.equal(state.apply, 'delta');

  // IPC 注册齐全，重复 init 幂等
  assert.deepEqual([...h.handlers.keys()].sort(), [
    'ffgui:updater-apply', 'ffgui:updater-check', 'ffgui:updater-state',
  ]);
  h.api.init();
  assert.equal(h.handlers.size, 3);
});

test('启动清理：pending 已装上或文件丢失时清掉标记与残留包', () => {
  // 1) 清单里的版本不再比当前新（上次已经装上了）
  const same = loadUpdater();
  fs.mkdirSync(same.updatesDir, { recursive: true });
  const sameFile = path.join(same.updatesDir, 'FFGui-0.7.4-x64-Setup.exe');
  fs.writeFileSync(sameFile, 'old');
  fs.writeFileSync(path.join(same.updatesDir, 'pending.json'), JSON.stringify({
    version: '0.7.4', apply: 'full', file: sameFile,
  }));
  fs.writeFileSync(path.join(same.updatesDir, 'last-check.json'), JSON.stringify({ checkedAt: Date.now() }));
  same.api.init();
  assert.equal(fs.existsSync(path.join(same.updatesDir, 'pending.json')), false);
  assert.equal(fs.existsSync(sameFile), false, '过期的待安装包要删掉');
  assert.equal(same.api.getState().state, 'none');

  // 2) apply 字段非法
  const bad = loadUpdater();
  fs.mkdirSync(bad.updatesDir, { recursive: true });
  const badFile = path.join(bad.updatesDir, 'delta-update-0.9.0-x64.exe');
  fs.writeFileSync(badFile, 'x');
  fs.writeFileSync(path.join(bad.updatesDir, 'pending.json'), JSON.stringify({
    version: '0.9.0', apply: 'zip', file: badFile,
  }));
  fs.writeFileSync(path.join(bad.updatesDir, 'last-check.json'), JSON.stringify({ checkedAt: Date.now() }));
  bad.api.init();
  assert.equal(fs.existsSync(path.join(bad.updatesDir, 'pending.json')), false);
  assert.equal(fs.existsSync(badFile), false);
  assert.equal(bad.api.getState().state, 'none');
});

// ---------- apply ----------

test('apply：没有待安装包时不做任何事', () => {
  const h = loadUpdater();
  const state = h.api.applyUpdate();
  assert.equal(state.state, 'none');
  assert.equal(h.events.length, 0);
  assert.equal(h.spawnCalls.length, 0);
});

test('apply：任务忙推 FFGUI_UPDATE_BUSY，spawn 失败推 FFGUI_UPDATE_SPAWN，成功才退出', async () => {
  const root = tempDir();
  const installDir = path.join(root, 'install');
  fs.mkdirSync(installDir, { recursive: true });
  const body = 'delta-package-bytes';
  const manifest = makeDeltaManifest(installDir, { packageSha256: sha256(body) });
  const { https } = deltaReleaseHttps(manifest, body);

  let spawnMode = 'ok';
  const spawnCalls = [];
  const spawn = (cmd, args, spawnOptions) => {
    if (spawnMode === 'throw') throw new Error('ENOENT');
    const child = new EventEmitter();
    child.unref = () => {
      child.unrefCalled = true;
    };
    spawnCalls.push({ cmd, args, spawnOptions, child });
    setImmediate(() => {
      if (spawnMode === 'error') child.emit('error', new Error('spawn 失败'));
      else child.emit('spawn');
    });
    return child;
  };
  const h = loadUpdater({ https, root, installDir, spawn });
  await h.api.checkForUpdates(true);
  assert.equal(h.api.getState().state, 'downloaded');

  // 1) 有任务在跑：拒绝安装并给可读错误码
  h.setBusy(true);
  h.api.applyUpdate();
  assert.equal(h.lastEvent().state, 'error');
  assert.equal(h.lastEvent().error, 'FFGUI_UPDATE_BUSY');
  assert.equal(spawnCalls.length, 0);
  assert.equal(h.quitCalls(), 0);

  // 2) spawn 同步抛错
  h.setBusy(false);
  spawnMode = 'throw';
  h.api.applyUpdate();
  assert.equal(h.lastEvent().state, 'error');
  assert.equal(h.lastEvent().error, 'FFGUI_UPDATE_SPAWN');
  assert.equal(h.quitCalls(), 0);

  // 3) spawn 返回后异步 error 事件
  spawnMode = 'error';
  h.api.applyUpdate();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.lastEvent().state, 'error');
  assert.equal(h.lastEvent().error, 'FFGUI_UPDATE_SPAWN');
  assert.equal(h.quitCalls(), 0);

  // 4) 正常启动：applying -> 子进程 spawn 事件 -> 退出应用
  spawnMode = 'ok';
  const returned = h.api.applyUpdate();
  assert.equal(returned.state, 'applying');
  assert.equal(returned.version, '0.8.0');
  assert.equal(returned.apply, 'delta');
  assert.equal(spawnCalls.length, 2, '异步 error 那次也调用了 spawn');
  const successCall = spawnCalls[spawnCalls.length - 1];
  assert.equal(successCall.cmd, path.join(h.updatesDir, manifest.package));
  assert.deepEqual([...successCall.args], ['/S']);
  assert.equal(successCall.spawnOptions.detached, true);
  assert.equal(successCall.spawnOptions.stdio, 'ignore');

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(successCall.child.unrefCalled, true);
  assert.equal(h.quitCalls(), 1);
  assertAllPayloads(h.events);
});

// ---------- delta 不适用时回退 full ----------

test('delta 不适用时下载完整安装包：apply=full，且不会请求增量包', async () => {
  const root = tempDir();
  const installDir = path.join(root, 'install');
  fs.mkdirSync(installDir, { recursive: true });
  const manifest = makeDeltaManifest(installDir, { fromVersion: '0.7.3' });
  const { https, deltaRequests, fullRequests } = deltaReleaseHttps(manifest, 'delta-body', 'full-body');
  const h = loadUpdater({ https, root, installDir });

  await h.api.checkForUpdates(true);

  assert.equal(deltaRequests.length, 0, '清单不适用时不应下载增量包');
  assert.equal(fullRequests.length, 1);
  assert.ok(fullRequests[0].url.endsWith('/full.exe'));
  const state = h.api.getState();
  assert.equal(state.state, 'downloaded');
  assert.equal(state.apply, 'full');
  assert.equal(
    fs.readFileSync(path.join(h.updatesDir, 'FFGui-0.8.0-x64-Setup.exe'), 'utf8'),
    'full-body',
  );
  assert.equal(h.events.find((event) => event.state === 'downloading').apply, 'full');
  assertAllPayloads(h.events);
});

// ---------- 状态机契约 ----------

test('状态机：available/downloading/downloaded/applying 的 payload 字段齐全', async () => {
  const root = tempDir();
  const installDir = path.join(root, 'install');
  fs.mkdirSync(installDir, { recursive: true });
  const body = 'delta-package-bytes';
  const manifest = makeDeltaManifest(installDir, { packageSha256: sha256(body) });
  const { https } = deltaReleaseHttps(manifest, body);
  const h = loadUpdater({ https, root, installDir });

  await h.api.checkForUpdates(true);
  h.api.applyUpdate();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(
    [...new Set(h.states())],
    ['checking', 'available', 'downloading', 'downloaded', 'applying'],
  );
  for (const event of h.events) {
    assertPayloadContract(event);
    if (event.state === 'available') assert.equal(event.version, '0.8.0');
    if (['downloaded', 'applying'].includes(event.state)) {
      assert.equal(event.version, '0.8.0');
      assert.equal(event.apply, 'delta');
    }
  }
});

// ---------- 非 Windows / 未打包 ----------

test('非 Windows 或未打包：init 不注册 IPC、不检查更新', () => {
  const unpackaged = loadUpdater({ isPackaged: false });
  unpackaged.api.init();
  assert.equal(unpackaged.handlers.size, 0);
  assert.equal(unpackaged.events.length, 0);
  assert.equal(unpackaged.api.getState().state, 'none');

  const linux = loadUpdater({ platform: 'linux' });
  linux.api.init();
  assert.equal(linux.handlers.size, 0);
  assert.equal(linux.events.length, 0);
  assert.equal(linux.api.getState().state, 'none');
});

// ---------- 跨版本链式增量 ----------

// 两跳链式环境：当前 0.7.4，中间版 0.7.5，最新 0.8.0
function chainReleaseHttps(installDir, options = {}) {
  const midBody = options.midBody || 'delta-0.7.5-bytes';
  const latestBody = options.latestBody || 'delta-0.8.0-bytes';
  const fullBody = options.fullBody || 'full-setup';
  const midManifest = makeDeltaManifest(installDir, {
    version: '0.7.5',
    fromVersion: '0.7.4',
    package: 'delta-update-0.7.5-x64.exe',
    packageSha256: sha256(midBody),
  });
  const latestManifest = makeDeltaManifest(installDir, {
    version: '0.8.0',
    fromVersion: '0.7.5',
    package: 'delta-update-0.8.0-x64.exe',
    packageSha256: sha256(latestBody),
  });
  const midAssets = options.midWithDelta === false
    ? [asset('FFGui-0.7.5-x64-Setup.exe', 'https://dl.example.com/full-0.7.5.exe')]
    : [
      asset('delta-update-0.7.5-x64.json', 'https://dl.example.com/manifest-0.7.5.json'),
      asset(midManifest.package, 'https://dl.example.com/delta-0.7.5.exe'),
      asset('FFGui-0.7.5-x64-Setup.exe', 'https://dl.example.com/full-0.7.5.exe'),
    ];
  const latestAssets = [
    asset('delta-update-0.8.0-x64.json', 'https://dl.example.com/manifest-0.8.0.json'),
    asset(latestManifest.package, 'https://dl.example.com/delta-0.8.0.exe'),
    asset('FFGui-0.8.0-x64-Setup.exe', 'https://dl.example.com/full.exe'),
  ];
  const fullRequests = [];
  const https = fakeHttps((record, cb) => {
    if (record.url === RELEASE_API) {
      cb(fakeResponse({ statusCode: 200, body: releaseBody('0.8.0', latestAssets) }));
      return;
    }
    if (record.url === RELEASES_API) {
      cb(fakeResponse({
        statusCode: 200,
        body: JSON.stringify([
          { tag_name: 'v0.8.0', assets: latestAssets },
          { tag_name: 'v0.7.5', assets: midAssets },
        ]),
      }));
      return;
    }
    if (record.url.endsWith('/manifest-0.7.5.json')) {
      cb(fakeResponse({ statusCode: 200, body: JSON.stringify(midManifest) }));
      return;
    }
    if (record.url.endsWith('/manifest-0.8.0.json')) {
      cb(fakeResponse({ statusCode: 200, body: JSON.stringify(latestManifest) }));
      return;
    }
    if (record.url.endsWith('/delta-0.7.5.exe')) {
      cb(fakeResponse({
        statusCode: 200,
        headers: { 'content-length': String(Buffer.byteLength(midBody)) },
        body: midBody,
      }));
      return;
    }
    if (record.url.endsWith('/delta-0.8.0.exe')) {
      cb(fakeResponse({
        statusCode: 200,
        headers: { 'content-length': String(Buffer.byteLength(latestBody)) },
        body: latestBody,
      }));
      return;
    }
    fullRequests.push(record);
    cb(fakeResponse({
      statusCode: 200,
      headers: { 'content-length': String(Buffer.byteLength(fullBody)) },
      body: fullBody,
    }));
  });
  return { https, midManifest, latestManifest, fullRequests };
}

test('链式增量：跨版本逐跳下载，pending 带 files，apply=delta', async () => {
  const root = tempDir();
  const installDir = path.join(root, 'install');
  fs.mkdirSync(installDir, { recursive: true });
  const { https, midManifest, latestManifest, fullRequests } = chainReleaseHttps(installDir);
  const h = loadUpdater({ https, root, installDir });

  await h.api.checkForUpdates(true);

  assert.equal(h.api.getState().state, 'downloaded');
  assert.equal(h.api.getState().apply, 'delta');
  assert.equal(h.api.getState().version, '0.8.0');
  assert.equal(fullRequests.length, 0, '链拼得成时不应下载完整包');
  for (const manifest of [midManifest, latestManifest]) {
    const target = path.join(h.updatesDir, manifest.package);
    assert.equal(fs.existsSync(target), true, `${manifest.package} 应已下载`);
  }
  const pending = JSON.parse(fs.readFileSync(path.join(h.updatesDir, 'pending.json'), 'utf8'));
  assert.equal(pending.version, '0.8.0');
  assert.equal(pending.apply, 'delta');
  assert.equal(pending.files.length, 2);
  assert.equal(pending.files[0].fromVersion, '0.7.4');
  assert.equal(pending.files[1].fromVersion, '0.7.5');
  assert.equal(pending.file, pending.files[1].file, 'file 恒等于最后一跳');
  assertAllPayloads(h.events);
  const downloading = h.events.filter((event) => event.state === 'downloading');
  assert.equal(downloading[downloading.length - 1].progress, 1, '末跳结束时进度应为 1');
});

test('链式增量：中间版本缺 delta 清单时断链，回退完整安装包', async () => {
  const root = tempDir();
  const installDir = path.join(root, 'install');
  fs.mkdirSync(installDir, { recursive: true });
  const { https, fullRequests } = chainReleaseHttps(installDir, { midWithDelta: false });
  const h = loadUpdater({ https, root, installDir });

  await h.api.checkForUpdates(true);

  assert.equal(h.api.getState().state, 'downloaded');
  assert.equal(h.api.getState().apply, 'full');
  assert.equal(fullRequests.length, 1);
  assert.equal(
    fs.readFileSync(path.join(h.updatesDir, 'FFGui-0.8.0-x64-Setup.exe'), 'utf8'),
    'full-setup',
  );
  assertAllPayloads(h.events);
});

test('链式安装：生成逐跳 ps1（每跳 /NORELAUNCH、末尾拉起应用），经 powershell 启动后退出', async () => {
  const root = tempDir();
  const installDir = path.join(root, 'install');
  fs.mkdirSync(installDir, { recursive: true });
  const { https, midManifest, latestManifest } = chainReleaseHttps(installDir);
  const h = loadUpdater({ https, root, installDir });
  await h.api.checkForUpdates(true);
  assert.equal(h.api.getState().state, 'downloaded');

  h.api.applyUpdate();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(h.spawnCalls.length, 1);
  const call = h.spawnCalls[0];
  assert.equal(call.cmd, 'powershell.exe');
  assert.deepEqual([...call.args].slice(0, 3), ['-NoProfile', '-ExecutionPolicy', 'Bypass']);
  assert.equal(call.spawnOptions.detached, true);
  assert.equal(call.spawnOptions.windowsHide, true);

  const scriptPath = call.args[4];
  assert.match(path.basename(scriptPath), /^delta-chain-0\.8\.0\.ps1$/);
  const content = fs.readFileSync(scriptPath, 'utf8');
  assert.equal(content.charCodeAt(0), 0xfeff, '脚本必须带 BOM（路径含中文）');
  const norelaunchCount = (content.match(/\/NORELAUNCH/g) || []).length;
  assert.equal(norelaunchCount, 2, '每一跳都要抑制自动重启');
  assert.ok(content.indexOf(midManifest.package) < content.indexOf(latestManifest.package),
    '跳的顺序必须是从旧到新');
  assert.ok(content.includes('Start-Process -FilePath'), '末尾要拉起应用');
  assert.ok(content.includes('FFGui.exe'));
  assert.equal(h.quitCalls(), 1);
  assertAllPayloads(h.events);
});

// 预写一条两跳链 pending（0.7.4→0.7.5→0.8.0），返回链文件列表
function seedChainPending(h) {
  fs.mkdirSync(h.updatesDir, { recursive: true });
  const files = ['0.7.5', '0.8.0'].map((version, index) => {
    const file = path.join(h.updatesDir, `delta-update-${version}-x64.exe`);
    fs.writeFileSync(file, `hop-${version}`);
    return {
      file,
      version,
      fromVersion: index === 0 ? '0.7.4' : '0.7.5',
      sha256: sha256(`hop-${version}`),
    };
  });
  fs.writeFileSync(path.join(h.updatesDir, 'pending.json'), JSON.stringify({
    version: '0.8.0',
    apply: 'delta',
    file: files[files.length - 1].file,
    files,
  }));
  fs.writeFileSync(path.join(h.updatesDir, 'last-check.json'), JSON.stringify({ checkedAt: Date.now() }));
  return files;
}

test('链式续装：上次中断后重进，已装上的跳被跳过', async () => {
  // 当前已是 0.7.5（第一跳装完、第二跳失败中断），pending 链是 0.7.4→0.7.5→0.8.0
  const h = loadUpdater({ currentVersion: '0.7.5' });
  seedChainPending(h);
  h.api.init();
  assert.equal(h.api.getState().state, 'downloaded');

  h.api.applyUpdate();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(h.spawnCalls.length, 1);
  const content = fs.readFileSync(h.spawnCalls[0].args[4], 'utf8');
  assert.ok(!content.includes('delta-update-0.7.5-x64.exe'), '已装上的跳不应再跑');
  assert.ok(content.includes('delta-update-0.8.0-x64.exe'), '剩余跳要继续');
  assert.equal((content.match(/\/NORELAUNCH/g) || []).length, 1);
  assert.equal(h.quitCalls(), 1);
});

test('链式续装：剩余链与当前版本对不上时作废 pending 并报 FFGUI_UPDATE_CHAIN', async () => {
  // 当前 0.7.6，剩余链的下一跳却要求 0.7.5 —— 对不上，必须作废
  const h = loadUpdater({ currentVersion: '0.7.6' });
  fs.mkdirSync(h.updatesDir, { recursive: true });
  const hopFile = path.join(h.updatesDir, 'delta-update-0.8.0-x64.exe');
  fs.writeFileSync(hopFile, 'hop-0.8.0');
  fs.writeFileSync(path.join(h.updatesDir, 'pending.json'), JSON.stringify({
    version: '0.8.0',
    apply: 'delta',
    file: hopFile,
    files: [
      {
        file: path.join(h.updatesDir, 'delta-update-0.7.5-x64.exe'),
        version: '0.7.5',
        fromVersion: '0.7.4',
        sha256: sha256('hop-0.7.5'),
      },
      {
        file: hopFile,
        version: '0.8.0',
        fromVersion: '0.7.5',
        sha256: sha256('hop-0.8.0'),
      },
    ],
  }));
  // 第一跳文件不存在没关系：loadPending 要求所有跳文件都在，补一个
  fs.writeFileSync(path.join(h.updatesDir, 'delta-update-0.7.5-x64.exe'), 'hop-0.7.5');
  fs.writeFileSync(path.join(h.updatesDir, 'last-check.json'), JSON.stringify({ checkedAt: Date.now() }));
  h.api.init();
  assert.equal(h.api.getState().state, 'downloaded');

  h.api.applyUpdate();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(h.lastEvent().state, 'error');
  assert.equal(h.lastEvent().error, 'FFGUI_UPDATE_CHAIN');
  assert.equal(h.spawnCalls.length, 0, '链损坏不得启动任何安装');
  assert.equal(fs.existsSync(path.join(h.updatesDir, 'pending.json')), false, 'pending 标记要清掉');
  assert.equal(h.quitCalls(), 0);
});

test('启动清理：链式 pending 的所有跳保留，过期脚本与旧包删除', () => {
  const h = loadUpdater();
  const files = seedChainPending(h);
  fs.writeFileSync(path.join(h.updatesDir, 'delta-chain-0.8.0.ps1'), 'old-script');
  fs.writeFileSync(path.join(h.updatesDir, 'delta-update-0.7.4-x64.exe'), 'stale');

  h.api.init();

  for (const hop of files) {
    assert.equal(fs.existsSync(hop.file), true, `${path.basename(hop.file)} 必须保留`);
  }
  assert.equal(fs.existsSync(path.join(h.updatesDir, 'delta-chain-0.8.0.ps1')), false,
    '过期链式脚本要清理');
  assert.equal(fs.existsSync(path.join(h.updatesDir, 'delta-update-0.7.4-x64.exe')), false);
  assert.equal(h.api.getState().state, 'downloaded');
  assert.equal(h.api.getState().apply, 'delta');
});
