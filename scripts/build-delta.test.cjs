'use strict';

// 运行：node --test scripts/build-delta.test.cjs
// 增量包生成脚本（scripts/build-delta.cjs）测试：
//   - 纯函数：目录扫描/差异分类、补丁命名、delta-files.nsh 渲染、参数解析；
//   - 主流程 buildDelta：mock spawnSync 模拟 xdelta3，不依赖真实 xdelta3 与 makensis
//     （一律传 compile: false）。build-installer.cjs 的 NSISBI 定位也换成桩，
//     避免测试机误下载/调用 makensis。

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const repo = path.resolve(__dirname, '..');
const SOURCE = fs.readFileSync(path.join(repo, 'scripts', 'build-delta.cjs'), 'utf8');
const quiet = { log() {}, warn() {}, error() {} };

const tempRoots = [];
after(() => {
  for (const dir of tempRoots) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix = 'ffgui-delta-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

// 按 {相对路径: 内容} 建一棵目录树
function makeTree(files) {
  const dir = tempDir('ffgui-delta-tree-');
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(dir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return dir;
}

// vm 加载：child_process 用注入的 spawnSync，./build-installer.cjs 换成纯桩
function loadBuildDelta(options = {}) {
  const spawnSync = options.spawnSync || (() => ({ status: 1, stdout: '', stderr: '' }));
  const ctx = {
    require: (name) => {
      if (name === 'child_process') return { spawnSync };
      if (name === './build-installer.cjs') {
        return {
          ensureNsisbi: () => {
            throw new Error('测试不应调用 makensis');
          },
          toNsisPath: (value) => value.replace(/\//g, '\\'),
          makeViVersion: (version) => {
            const parts = version.split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
            while (parts.length < 4) parts.push(0);
            return parts.slice(0, 4).join('.');
          },
        };
      }
      return require(name);
    },
    process,
    console: quiet,
    module: { exports: {} },
    __dirname: path.join(repo, 'scripts'),
    Buffer,
    setTimeout,
    clearTimeout,
    setImmediate,
    URL,
  };
  vm.createContext(ctx);
  vm.runInContext(SOURCE, ctx);
  return ctx.module.exports;
}

// 假 xdelta3：-V 报版本；编码把目标文件内容记在补丁路径上；解码写出记录的内容。
// corruptDecode 时解码产物被篡改，用来验证「回放 sha256 不一致 -> 回退 copy」。
function fakeXdeltaTools({ corruptDecode = false } = {}) {
  const calls = [];
  const patchData = new Map();
  const spawnSync = (cmd, args) => {
    calls.push({ cmd, args });
    if (args[0] === '-V') {
      return { status: 0, stdout: 'xdelta3 version 3.1.0 (fake)\n', stderr: '' };
    }
    if (args.includes('-e')) {
      const target = args[args.length - 2];
      const patch = args[args.length - 1];
      const data = fs.readFileSync(target);
      patchData.set(patch, data);
      fs.writeFileSync(
        patch,
        Buffer.concat([Buffer.from('VCDIFF'), data.subarray(0, Math.min(32, data.length))]),
      );
      return { status: 0, stdout: '', stderr: '' };
    }
    if (args.includes('-d')) {
      // ['-f', '-d', '-s', 源文件, 补丁, 输出]
      const data = patchData.get(args[4]);
      if (!data) return { status: 1, stdout: '', stderr: 'patch not found' };
      fs.writeFileSync(args[5], corruptDecode ? Buffer.from('tampered') : data);
      return { status: 0, stdout: '', stderr: '' };
    }
    return { status: 1, stdout: '', stderr: 'unsupported' };
  };
  return { calls, spawnSync };
}

// ---------- 目录扫描 / 差异分类 ----------

test('scanDiff：零差异时 added/changed/removed 为空，unchanged 列出全部文件', () => {
  const api = loadBuildDelta();
  const files = { 'a.txt': 'same', 'dir/b.bin': 'same2', 'dir/deep/c.dat': 'same3' };
  const diff = api.scanDiff(makeTree(files), makeTree(files));

  assert.deepEqual([...diff.added], []);
  assert.deepEqual([...diff.changed], []);
  assert.deepEqual([...diff.removed], []);
  assert.deepEqual([...diff.unchanged], ['a.txt', 'dir/b.bin', 'dir/deep/c.dat']);
  // 相对路径统一正斜杠（manifest 契约）
  assert.ok(diff.unchanged.every((rel) => !rel.includes('\\')));
});

test('scanDiff：新增/删除/修改分类正确，变更项带新旧大小与哈希', () => {
  const api = loadBuildDelta();
  const prev = makeTree({
    'same.txt': 'same',
    'changed.txt': 'old-content',
    'size.bin': '1234',
    'removed.txt': 'bye',
    'nested/keep.txt': 'keep',
  });
  const app = makeTree({
    'same.txt': 'same',
    'changed.txt': 'new-content',
    'size.bin': '12', // 大小不同也必须进 changed
    'added.txt': 'hello',
    'nested/keep.txt': 'keep',
    'nested/new/deep.txt': 'deep',
  });

  const diff = api.scanDiff(app, prev);

  assert.deepEqual([...diff.added].map((item) => item.path), ['added.txt', 'nested/new/deep.txt']);
  assert.equal(diff.added[0].size, 5);
  assert.equal(diff.added[0].sha256, sha256('hello'));

  assert.deepEqual([...diff.removed], ['removed.txt']);
  assert.deepEqual([...diff.unchanged], ['nested/keep.txt', 'same.txt']);

  assert.deepEqual([...diff.changed].map((item) => item.path), ['changed.txt', 'size.bin']);
  const changed = diff.changed.find((item) => item.path === 'changed.txt');
  assert.equal(changed.size, Buffer.byteLength('new-content'));
  assert.equal(changed.sha256, sha256('new-content'));
  assert.equal(changed.sourceSize, Buffer.byteLength('old-content'));
  assert.equal(changed.sourceSha256, sha256('old-content'));
  const resized = diff.changed.find((item) => item.path === 'size.bin');
  assert.equal(resized.size, 2);
  assert.equal(resized.sourceSize, 4);
  assert.equal(resized.sha256, sha256('12'));
  assert.equal(resized.sourceSha256, sha256('1234'));
});

test('listFiles：递归返回 Map<正斜杠相对路径, {absPath,size}>', () => {
  const api = loadBuildDelta();
  const dir = makeTree({ 'root.txt': '1', 'a/b/c.txt': '22' });
  const files = api.listFiles(dir);
  assert.deepEqual([...files.keys()].sort(), ['a/b/c.txt', 'root.txt']);
  assert.equal(files.get('a/b/c.txt').size, 2);
  assert.equal(files.get('a/b/c.txt').absPath, path.join(dir, 'a', 'b', 'c.txt'));
  assert.equal(api.sha256File(path.join(dir, 'a', 'b', 'c.txt')), sha256('22'));
});

// ---------- 补丁命名 ----------

test('assignPatchNames：basename 不冲突用原名，冲突组统一改用相对路径，且大小写去重', () => {
  const api = loadBuildDelta();
  const named = api.assignPatchNames([
    { path: 'resources/ffmpeg.exe' },
    { path: 'resources/bin/ffmpeg.exe' },
    { path: 'ffmpeg.exe' },
    // 与第一条生成的 resources__ffmpeg.exe 撞名，需要再加序号
    { path: 'resources__ffmpeg.exe' },
    // basename 唯一，但与 ffmpeg.exe 大小写不敏感撞名
    { path: 'FFMPEG.EXE' },
    { path: 'unique.txt' },
  ]);

  assert.deepEqual(named.map((item) => item.patch), [
    'resources__ffmpeg.exe.vcdiff',
    'resources__bin__ffmpeg.exe.vcdiff',
    'ffmpeg.exe.vcdiff',
    'resources__ffmpeg.exe-2.vcdiff',
    'FFMPEG.EXE-2.vcdiff',
    'unique.txt.vcdiff',
  ]);
  // 所有名字在 Windows 文件系统下唯一
  const lower = named.map((item) => item.patch.toLowerCase());
  assert.equal(new Set(lower).size, lower.length);
  // 除 patch 字段外保留原有信息
  assert.equal(named[0].path, 'resources/ffmpeg.exe');
});

test('assignPatchNames：没有冲突时保留 basename，输入顺序无关', () => {
  const api = loadBuildDelta();
  const items = [{ path: 'a/one.dll' }, { path: 'b/two.dll' }];
  const forward = api.assignPatchNames(items);
  assert.deepEqual(forward.map((item) => item.patch), ['one.dll.vcdiff', 'two.dll.vcdiff']);
  const reversed = api.assignPatchNames([...items].reverse());
  assert.deepEqual(reversed.map((item) => item.patch), ['two.dll.vcdiff', 'one.dll.vcdiff']);
});

// ---------- delta-files.nsh ----------

test('renderDeltaNsh：补丁 -> 全量覆盖 -> 删除，路径转反斜杠并转义 $', () => {
  const api = loadBuildDelta();
  const nsh = api.renderDeltaNsh(
    [
      { path: 'resources/app.asar', method: 'xdelta3', patch: 'app.asar.vcdiff' },
      { path: 'locales/zh-CN.pak', method: 'copy' },
      { path: 'money$file.txt', method: 'copy' },
    ],
    ['old/removed.dll', 'gone.txt'],
  );

  const lines = nsh.split('\r\n').filter(Boolean);
  assert.ok(lines[0].startsWith('; 本文件由 scripts/build-delta.cjs 自动生成'));
  const patchIndex = lines.findIndex((line) => line.includes('ApplyPatch'));
  const copyIndex = lines.findIndex((line) => line.includes('ApplyCopy'));
  const removeIndex = lines.findIndex((line) => line.includes('ApplyRemove'));
  assert.ok(patchIndex >= 0 && copyIndex > patchIndex, '先打补丁再覆盖全量');
  assert.ok(removeIndex > copyIndex, '删除放最后');

  assert.equal(
    lines[patchIndex],
    '!insertmacro ApplyPatch "resources\\app.asar" "patches\\app.asar.vcdiff"',
  );
  assert.ok(lines.includes('!insertmacro ApplyCopy "locales\\zh-CN.pak"'));
  // NSIS 里 $ 是变量前缀，必须写成 $$
  assert.ok(lines.includes('!insertmacro ApplyCopy "money$$file.txt"'));
  assert.ok(lines.includes('!insertmacro ApplyRemove "old\\removed.dll"'));
  assert.ok(lines.includes('!insertmacro ApplyRemove "gone.txt"'));
});

// ---------- buildDelta：xdelta3 不可用时回退 copy ----------

test('buildDelta：xdelta3 不可用，变更大文件回退 copy 并生成一致清单', () => {
  const LARGE = 1024 * 1024;
  const bigOld = Buffer.alloc(LARGE + 16, 0x41);
  const bigNew = Buffer.alloc(LARGE + 16, 0x42);
  const appDir = makeTree({
    'big.bin': bigNew,
    'small.txt': 'new-small',
    'added.txt': 'added',
  });
  const prevDir = makeTree({
    'big.bin': bigOld,
    'small.txt': 'old-small',
    'removed.txt': 'bye',
  });
  const outDir = tempDir();

  // 记录是否真的调用过 xdelta3：探测看到文件不存在就应直接放弃
  const calls = [];
  const api = loadBuildDelta({
    spawnSync: (cmd, args) => {
      calls.push({ cmd, args });
      return { status: 1, stdout: '', stderr: 'should not run' };
    },
  });

  const result = api.buildDelta({
    appDir,
    prevDir,
    xdelta3Path: path.join(outDir, 'missing-xdelta3.exe'),
    outDir,
    arch: 'x64',
    version: '0.8.0',
    fromVersion: '0.7.4',
    compile: false,
  });

  assert.equal(calls.length, 0, 'xdelta3 不存在时不应执行它');
  assert.equal(result.outFile, '');
  assert.equal(result.diff.changed.length, 2, 'big.bin 与 small.txt 都变了');
  assert.equal(result.diff.removed.length, 1);

  const manifest = result.manifest;
  assert.equal(manifest.schema, 1);
  assert.equal(manifest.version, '0.8.0');
  assert.equal(manifest.fromVersion, '0.7.4');
  assert.equal(manifest.arch, 'x64');
  assert.equal(manifest.package, 'delta-update-0.8.0-x64.exe');
  assert.equal(manifest.packageSha256, '', '--no-compile 时安装包哈希留空');
  assert.equal(manifest.fullSetup, 'FFGui-0.8.0-x64-Setup.exe');
  assert.deepEqual([...manifest.files].map((file) => file.path),
    ['added.txt', 'big.bin', 'small.txt']);
  assert.ok(manifest.files.every((file) => file.method === 'copy'));
  const big = manifest.files.find((file) => file.path === 'big.bin');
  assert.equal(big.sha256, sha256(bigNew));
  assert.equal(big.size, bigNew.length);
  assert.equal(big.sourceSha256, undefined, 'copy 条目不带 sourceSha256');
  assert.deepEqual([...manifest.removed], ['removed.txt']);

  // payload 镜像全量文件；没有补丁时不保留 patches/ 与 xdelta3.exe
  for (const rel of ['added.txt', 'big.bin', 'small.txt']) {
    assert.ok(fs.existsSync(path.join(outDir, 'payload', rel)), `${rel} 应进 payload`);
  }
  assert.equal(fs.existsSync(path.join(outDir, 'payload', 'patches')), false);
  assert.equal(fs.existsSync(path.join(outDir, 'payload', 'xdelta3.exe')), false);
  assert.equal(fs.existsSync(path.join(outDir, '.delta-tmp')), false, '临时目录用完即删');

  // delta-files.nsh 带 BOM，内容是 ApplyCopy + ApplyRemove
  const nsh = fs.readFileSync(path.join(outDir, 'delta-files.nsh'), 'utf8');
  assert.equal(nsh.charCodeAt(0), 0xFEFF);
  assert.ok(nsh.includes('ApplyCopy "big.bin"'));
  assert.ok(nsh.includes('ApplyRemove "removed.txt"'));
  assert.ok(!nsh.includes('ApplyPatch'));

  // 两份清单内容一致
  const named = JSON.parse(fs.readFileSync(
    path.join(outDir, 'delta-update-0.8.0-x64.json'), 'utf8',
  ));
  const plain = JSON.parse(fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8'));
  assert.deepEqual(named, plain);
  assert.deepEqual(named.files.map((file) => file.path), ['added.txt', 'big.bin', 'small.txt']);
});

// ---------- buildDelta：xdelta3 补丁成功 ----------

test('buildDelta：补丁生成后回放 sha256 一致，写 method=xdelta3 并随包分发 xdelta3.exe', () => {
  const LARGE = 1024 * 1024;
  const bigOld = Buffer.alloc(LARGE + 32, 0x11);
  const bigNew = Buffer.alloc(LARGE + 32, 0x22);
  const appDir = makeTree({ 'resources/big.bin': bigNew, 'added.txt': 'added' });
  const prevDir = makeTree({ 'resources/big.bin': bigOld });
  const outDir = tempDir();
  const xdelta3Path = path.join(tempDir(), 'xdelta3.exe');
  fs.writeFileSync(xdelta3Path, 'fake-xdelta3-binary');

  const fake = fakeXdeltaTools();
  const api = loadBuildDelta({ spawnSync: fake.spawnSync });

  const result = api.buildDelta({
    appDir, prevDir, xdelta3Path, outDir,
    arch: 'x64', version: '0.8.0', fromVersion: '0.7.4', compile: false,
  });

  const patch = result.manifest.files.find((file) => file.path === 'resources/big.bin');
  assert.equal(patch.method, 'xdelta3');
  assert.equal(patch.patch, 'big.bin.vcdiff');
  assert.equal(patch.sha256, sha256(bigNew));
  assert.equal(patch.sourceSha256, sha256(bigOld));
  assert.ok(patch.patchSize > 0);
  // copy 条目只有新增文件
  assert.deepEqual(
    [...result.manifest.files].filter((file) => file.method === 'copy').map((file) => file.path),
    ['added.txt'],
  );

  const patchFile = path.join(outDir, 'payload', 'patches', 'big.bin.vcdiff');
  assert.ok(fs.existsSync(patchFile), '补丁应落到 payload/patches/');
  assert.equal(fs.statSync(patchFile).size, patch.patchSize);
  assert.equal(fs.readFileSync(path.join(outDir, 'payload', 'xdelta3.exe'), 'utf8'),
    'fake-xdelta3-binary');

  const nsh = fs.readFileSync(path.join(outDir, 'delta-files.nsh'), 'utf8');
  assert.ok(nsh.includes('ApplyPatch "resources\\big.bin" "patches\\big.bin.vcdiff"'));

  // 先带 -S lzma 试一次，再用无 lzma 的退路
  const encodes = fake.calls.filter((call) => call.args.includes('-e'));
  assert.equal(encodes.length, 1);
  assert.deepEqual([...encodes[0].args].slice(0, 4), ['-f', '-e', '-S', 'lzma']);
  const decodes = fake.calls.filter((call) => call.args.includes('-d'));
  assert.equal(decodes.length, 1);
});

test('buildDelta：回放产物 sha256 不一致时两次尝试都失败，回退 copy', () => {
  const LARGE = 1024 * 1024;
  const appDir = makeTree({ 'big.bin': Buffer.alloc(LARGE + 8, 0x22) });
  const prevDir = makeTree({ 'big.bin': Buffer.alloc(LARGE + 8, 0x11) });
  const outDir = tempDir();
  const xdelta3Path = path.join(tempDir(), 'xdelta3.exe');
  fs.writeFileSync(xdelta3Path, 'fake');

  const fake = fakeXdeltaTools({ corruptDecode: true });
  const api = loadBuildDelta({ spawnSync: fake.spawnSync });
  const result = api.buildDelta({
    appDir, prevDir, xdelta3Path, outDir,
    arch: 'arm64', version: '0.8.0', fromVersion: '0.7.4', compile: false,
  });

  const entry = result.manifest.files.find((file) => file.path === 'big.bin');
  assert.equal(entry.method, 'copy', '回放校验失败必须回退全量');
  assert.equal(entry.patch, undefined);
  assert.equal(fake.calls.filter((call) => call.args.includes('-e')).length, 2,
    'lzma 与无 lzma 两条路径都试过');
  assert.equal(fake.calls.filter((call) => call.args.includes('-d')).length, 2);
  assert.equal(fs.existsSync(path.join(outDir, 'payload', 'patches')), false);
  assert.equal(fs.existsSync(path.join(outDir, 'payload', 'xdelta3.exe')), false);
  assert.ok(fs.existsSync(path.join(outDir, 'payload', 'big.bin')), '回退后大文件进 payload');
});

// ---------- 参数与校验 ----------

test('parseArgs：必填项、未知参数与 --no-compile', () => {
  const api = loadBuildDelta();
  const opts = api.parseArgs([
    '--app-dir', 'app', '--prev-dir', 'prev', '--out-dir', 'out',
    '--xdelta3', 'xdelta3.exe', '--arch', 'x64',
    '--version', '0.8.0', '--from-version', '0.7.4', '--no-compile',
  ]);
  assert.equal(opts.appDir, path.resolve('app'));
  assert.equal(opts.prevDir, path.resolve('prev'));
  assert.equal(opts.outDir, path.resolve('out'));
  assert.equal(opts.xdelta3Path, 'xdelta3.exe');
  assert.equal(opts.compile, false);

  assert.throws(() => api.parseArgs(['--unknown']), /未知参数/);
  assert.throws(() => api.parseArgs(['--arch', 'x64']), /缺少必填参数/);
  assert.throws(() => api.parseArgs(['--app-dir', 'a', '--prev-dir', 'b', '--out-dir', 'c']),
    /缺少 --arch/);
  assert.throws(() => api.parseArgs([
    '--app-dir', 'a', '--prev-dir', 'b', '--out-dir', 'c', '--arch', 'x64',
  ]), /缺少 --version/);
});

test('buildDelta：非法架构 / 目录不存在 / 文件路径与包结构冲突都抛错', () => {
  const appDir = makeTree({ 'ok.txt': 'x' });
  const prevDir = makeTree({ 'ok.txt': 'x' });
  const outDir = tempDir();
  const base = {
    appDir, prevDir, outDir, version: '0.8.0', fromVersion: '0.7.4', compile: false,
  };
  const api = loadBuildDelta();

  assert.throws(() => api.buildDelta({ ...base, arch: 'ia32' }), /x64 或 arm64/);
  assert.throws(() => api.buildDelta({
    ...base, arch: 'x64', appDir: path.join(outDir, 'missing'),
  }), /--app-dir 不是目录/);
  assert.throws(() => api.buildDelta({ ...base, arch: 'x64', version: '' }), /缺少 --version/);

  // 新增文件占用增量包内部保留路径 -> 直接失败，而不是生成损坏的包
  const conflictApp = makeTree({ 'patches/evil.txt': 'x' });
  assert.throws(() => api.buildDelta({
    ...base, arch: 'x64', appDir: conflictApp,
  }), /路径与增量包内部结构冲突/);
});
