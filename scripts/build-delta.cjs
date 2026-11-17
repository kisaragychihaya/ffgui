// 生成 Windows 增量更新包（delta update）
//
// 用法：
//   node scripts/build-delta.cjs --app-dir <新 unpacked 目录> --prev-dir <旧 unpacked 目录> \
//     --xdelta3 <xdelta3.exe 路径> --out-dir <输出目录> --arch <x64|arm64> \
//     --version <新版> --from-version <旧版> [--no-compile]
//
// 产物（均在 --out-dir 下）：
//   payload/                     全量覆盖文件（按相对路径镜像）+ patches/*.vcdiff + xdelta3.exe
//   delta-files.nsh              由 assets/delta-installer.nsi 展开的逐文件指令
//   manifest.json                清单（契约见 docs/build-release.md）
//   delta-update-<ver>-<arch>.json  同上（Release 资产名）
//   delta-update-<ver>-<arch>.exe   增量安装包（--no-compile 时不生成）
//
// 大文件（>1MB）优先用 xdelta3 生成补丁，生成后立刻回放验证 sha256；xdelta3 缺失、
// 超时、失败或回放不一致时该文件回退为全量覆盖（method=copy），保证安装包永远可用。
// xdelta3 只随 CI / 增量包分发，仓库与本地开发环境不需要它。

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

// NSISBI 定位、路径转换、版本号格式化复用 build-installer.cjs（见该文件的实现）
const { ensureNsisbi, toNsisPath, makeViVersion } = require('./build-installer.cjs');

const ROOT = path.resolve(__dirname, '..');
const BOM = '\uFEFF';
const LARGE_FILE_THRESHOLD = 1024 * 1024; // 1MB：超过才尝试 xdelta3
const ENCODE_TIMEOUT_MS = 180 * 1000;
const DECODE_TIMEOUT_MS = 120 * 1000;
const PROBE_TIMEOUT_MS = 15 * 1000;
const LOG_PREFIX = '[delta]';

function log(message) {
  console.log(`${LOG_PREFIX} ${message}`);
}

function warn(message) {
  console.warn(`${LOG_PREFIX} ${message}`);
}

// ---------------------------------------------------------------
// 文件扫描与哈希
// ---------------------------------------------------------------

// 递归列出目录下所有文件，返回 Map<正斜杠相对路径, {absPath, size}>
// 相对路径统一用正斜杠，与 manifest 契约一致
function listFiles(dir) {
  const result = new Map();
  const walk = (current, prefix) => {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(absPath, rel);
      } else if (entry.isFile()) {
        result.set(rel, { absPath, size: fs.statSync(absPath).size });
      } else {
        // Electron 分发目录在 Windows 上没有符号链接；遇到时跳过并提示，避免递归环
        warn(`跳过非普通文件：${rel}`);
      }
    }
  };
  walk(dir, '');
  return result;
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytesRead;
    while ((bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

// 对比新旧 unpacked 目录：
//   added    新版独有（全量覆盖）
//   removed  旧版独有（安装时删除）
//   changed  两边都有但 sha256 不同
//   unchanged 完全一致
// 返回的对象只含路径/大小/哈希，不依赖目录之外的上下文，方便单测
function scanDiff(appDir, prevDir) {
  const appFiles = listFiles(appDir);
  const prevFiles = listFiles(prevDir);
  const added = [];
  const changed = [];
  const unchanged = [];
  const removed = [];

  for (const [rel, info] of appFiles) {
    const prev = prevFiles.get(rel);
    if (!prev) {
      added.push({ path: rel, size: info.size, sha256: sha256File(info.absPath) });
      continue;
    }
    if (prev.size !== info.size) {
      changed.push({
        path: rel,
        size: info.size,
        sha256: sha256File(info.absPath),
        sourceSize: prev.size,
        sourceSha256: sha256File(prev.absPath),
      });
      continue;
    }
    const newHash = sha256File(info.absPath);
    const oldHash = sha256File(prev.absPath);
    if (newHash === oldHash) {
      unchanged.push(rel);
    } else {
      changed.push({
        path: rel,
        size: info.size,
        sha256: newHash,
        sourceSize: prev.size,
        sourceSha256: oldHash,
      });
    }
  }
  for (const rel of prevFiles.keys()) {
    if (!appFiles.has(rel)) removed.push(rel);
  }

  added.sort((a, b) => a.path.localeCompare(b.path));
  changed.sort((a, b) => a.path.localeCompare(b.path));
  unchanged.sort();
  removed.sort();
  return { added, changed, removed, unchanged };
}

// ---------------------------------------------------------------
// xdelta3 补丁生成 / 回放验证
// ---------------------------------------------------------------

// xdelta3 是否可用（-V 打印版本并返回 0；缺失/不可执行都按不可用处理）
function probeXdelta3(xdelta3Path) {
  if (!xdelta3Path || !fs.existsSync(xdelta3Path)) return false;
  const result = spawnSync(xdelta3Path, ['-V'], {
    encoding: 'utf8',
    timeout: PROBE_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.status !== 0) {
    warn(`xdelta3 不可用（退出码 ${result.status}）：${xdelta3Path}`);
    return false;
  }
  const versionLine = `${result.stdout || ''}\n${result.stderr || ''}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  log(`xdelta3 可用：${versionLine || xdelta3Path}`);
  return true;
}

function runXdelta(xdelta3Path, args, timeout) {
  return spawnSync(xdelta3Path, args, {
    encoding: 'utf8',
    timeout,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
}

// 把补丁应用到旧文件，输出到 outPath；返回 { ok, stderr }
function applyPatch({ xdelta3Path, sourcePath, patchPath, outPath, timeout = DECODE_TIMEOUT_MS }) {
  fs.rmSync(outPath, { force: true });
  const result = runXdelta(
    xdelta3Path,
    ['-f', '-d', '-s', sourcePath, patchPath, outPath],
    timeout
  );
  return {
    ok: result.status === 0 && fs.existsSync(outPath),
    status: result.status,
    error: (result.stderr || result.error?.message || '').trim(),
  };
}

// 生成补丁并做「旧文件 + 补丁 → 新文件」回放校验。
// 先尝试 -S lzma（体积更小）；个别 xdelta3 构建未编入 lzma 时去掉该参数重试。
// 返回 { ok, patchSize, reason }
function makeVerifiedPatch({ xdelta3Path, sourcePath, targetPath, patchPath, targetSha256 }) {
  fs.mkdirSync(path.dirname(patchPath), { recursive: true });
  const attempts = [
    ['-f', '-e', '-S', 'lzma', '-9', '-s', sourcePath, targetPath, patchPath],
    ['-f', '-e', '-9', '-s', sourcePath, targetPath, patchPath],
  ];
  let lastError = '';
  for (const args of attempts) {
    fs.rmSync(patchPath, { force: true });
    const result = runXdelta(xdelta3Path, args, ENCODE_TIMEOUT_MS);
    if (result.status !== 0 || !fs.existsSync(patchPath)) {
      lastError = `编码失败（退出码 ${result.status}）${(result.stderr || '').trim()}`;
      continue;
    }
    const patchSize = fs.statSync(patchPath).size;
    if (patchSize === 0) {
      lastError = '编码产物为空';
      continue;
    }
    const verifyPath = `${patchPath}.verify`;
    try {
      const applied = applyPatch({
        xdelta3Path,
        sourcePath,
        patchPath,
        outPath: verifyPath,
      });
      if (!applied.ok) {
        lastError = `回放失败：${applied.error || `退出码 ${applied.status}`}`;
        continue;
      }
      if (sha256File(verifyPath) !== targetSha256) {
        lastError = '回放产物 sha256 与新文件不一致';
        continue;
      }
      return { ok: true, patchSize };
    } finally {
      fs.rmSync(verifyPath, { force: true });
    }
  }
  fs.rmSync(patchPath, { force: true });
  return { ok: false, reason: lastError || '未知错误' };
}

// ---------------------------------------------------------------
// 补丁命名
// ---------------------------------------------------------------

// patch 文件平铺在 payload/patches/ 下，默认用 basename；同名冲突时改用
// 相对路径把 / 换成 __（如 resources__ffmpeg.exe），并在 manifest.patch 写实际名。
// 冲突组内**所有**文件都用完整路径命名，结果与遍历顺序无关。
function assignPatchNames(changed) {
  const counts = new Map();
  for (const item of changed) {
    const base = path.posix.basename(item.path);
    counts.set(base, (counts.get(base) || 0) + 1);
  }
  const used = new Set();
  return changed.map((item) => {
    const base = path.posix.basename(item.path);
    let name = counts.get(base) > 1 ? item.path.replace(/\//g, '__') : base;
    let candidate = name;
    let index = 2;
    // Windows 文件系统大小写不敏感，去重也按小写比较
    while (used.has(candidate.toLowerCase())) {
      candidate = `${name}-${index}`;
      index += 1;
    }
    used.add(candidate.toLowerCase());
    return { ...item, patch: `${candidate}.vcdiff` };
  });
}

// ---------------------------------------------------------------
// 生成 NSIS include
// ---------------------------------------------------------------

// 生成 delta-files.nsh：补丁在前、全量覆盖在后、删除最后（保证失败时小文件仍为旧版）
function renderDeltaNsh(files, removed) {
  const lines = [
    '; 本文件由 scripts/build-delta.cjs 自动生成，请勿手工编辑',
    '',
  ];
  for (const file of files) {
    if (file.method === 'xdelta3') {
      lines.push(
        `!insertmacro ApplyPatch "${nsisEscape(toNsisRel(file.path))}" "patches\\${nsisEscape(toNsisRel(file.patch))}"`
      );
    }
  }
  for (const file of files) {
    if (file.method === 'copy') {
      lines.push(`!insertmacro ApplyCopy "${nsisEscape(toNsisRel(file.path))}"`);
    }
  }
  for (const rel of removed) {
    lines.push(`!insertmacro ApplyRemove "${nsisEscape(toNsisRel(rel))}"`);
  }
  lines.push('');
  return lines.join('\r\n');
}

// NSIS 的 File/SetOutPath 使用 Windows 反斜杠；manifest 仍保持正斜杠契约
function toNsisRel(value) {
  return value.replace(/\//g, '\\');
}

// NSIS 字符串里 $ 会被当变量前缀，文件名含 $ 时需写成 $$；双引号在 Windows 文件名中非法
function nsisEscape(value) {
  return value.replace(/\$/g, '$$$$');
}

// ---------------------------------------------------------------
// 安装包编译
// ---------------------------------------------------------------

// 复制 nsi 脚本并补 UTF-8 BOM 后编译：makensis 把无 BOM 文件按 ANSI 解析，
// 中文注释会报 Bad text encoding（手法与 build-installer.cjs 完全一致）
function compileDeltaInstaller({ outFile, defines }) {
  const makensis = ensureNsisbi(path.join(ROOT, 'tools', 'nsisbi'));
  const script = path.join(ROOT, 'assets', 'delta-installer.nsi');
  if (!fs.existsSync(script)) throw new Error(`增量安装脚本不存在：${script}`);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffgui-delta-nsis-'));
  try {
    const definesFile = path.join(tmpDir, 'defines.nsh');
    fs.writeFileSync(definesFile, BOM + defines.join('\r\n'), 'utf8');
    const scriptTmp = path.join(tmpDir, 'delta-installer.nsi');
    fs.writeFileSync(scriptTmp, BOM + fs.readFileSync(script, 'utf8'), 'utf8');

    log(`makensis 编译中：${outFile}`);
    const result = spawnSync(
      makensis,
      ['/V2', `/DGEN_DEFINES=${toNsisPath(definesFile)}`, toNsisPath(scriptTmp)],
      { encoding: 'utf8' }
    );
    for (const line of (result.stdout || '').split(/\r?\n/)) {
      if (line.trim()) console.log(`[nsis] ${line}`);
    }
    for (const line of (result.stderr || '').split(/\r?\n/)) {
      if (line.trim()) console.error(`[nsis-err] ${line}`);
    }
    if (result.status !== 0) {
      throw new Error(`makensis 编译失败（退出码 ${result.status}）`);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  if (!fs.existsSync(outFile)) {
    throw new Error(`makensis 报告成功但未生成增量安装包：${outFile}`);
  }
}

function buildDefines({ outFile, version, fromVersion, payloadDir, deltaData, hasPatches }) {
  return [
    '!define APP_ID "ffgui"',
    '!define APP_NAME "狒狒格式工具箱"',
    '!define APP_EXE "FFGui.exe"',
    `!define APP_VERSION "${version}"`,
    `!define FROM_VERSION "${fromVersion}"`,
    '!define REG_UNINST "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ffgui"',
    `!define OUT_FILE "${toNsisPath(outFile)}"`,
    `!define PAYLOAD_DIR "${toNsisPath(payloadDir)}"`,
    `!define DELTA_DATA "${toNsisPath(deltaData)}"`,
    `!define HAS_PATCHES ${hasPatches ? 1 : 0}`,
    `!define VI_VERSION "${makeViVersion(version)}"`,
    `!define FILE_DESCRIPTION "FFGui ${version} Delta Update"`,
    `!define ORIGINAL_FILENAME "${path.basename(outFile)}"`,
    `!define LEGAL_COPYRIGHT "Copyright (C) ${new Date().getFullYear()} kisaragychihaya · LGPL-3.0-or-later"`,
  ];
}

function writeManifests({ outDir, manifest, manifestName }) {
  const json = `${JSON.stringify(manifest, null, 2)}\n`;
  fs.writeFileSync(path.join(outDir, 'manifest.json'), json, 'utf8');
  fs.writeFileSync(path.join(outDir, manifestName), json, 'utf8');
}

// ---------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------

function buildDelta(options) {
  const {
    appDir,
    prevDir,
    xdelta3Path,
    outDir,
    arch,
    version,
    fromVersion,
    compile = true,
  } = options;

  if (!['x64', 'arm64'].includes(arch)) {
    throw new Error(`--arch 只能是 x64 或 arm64（收到：${arch}）`);
  }
  for (const [label, dir] of [
    ['--app-dir', appDir],
    ['--prev-dir', prevDir],
  ]) {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      throw new Error(`${label} 不是目录：${dir}`);
    }
  }
  if (!version || !fromVersion) throw new Error('缺少 --version 或 --from-version');

  fs.mkdirSync(outDir, { recursive: true });
  const payloadDir = path.join(outDir, 'payload');
  const patchesDir = path.join(payloadDir, 'patches');
  // 补丁先生成到独立临时目录，避免临时名与 payload 内文件/补丁名冲突
  const tmpPatchDir = path.join(outDir, '.delta-tmp');
  fs.rmSync(payloadDir, { recursive: true, force: true });
  fs.rmSync(tmpPatchDir, { recursive: true, force: true });
  fs.mkdirSync(patchesDir, { recursive: true });
  fs.mkdirSync(tmpPatchDir, { recursive: true });

  log(`扫描新目录：${appDir}`);
  log(`扫描旧目录：${prevDir}`);
  const diff = scanDiff(appDir, prevDir);
  log(
    `差异：新增 ${diff.added.length}、变更 ${diff.changed.length}、删除 ${diff.removed.length}、未变 ${diff.unchanged.length}`
  );

  const xdeltaReady = probeXdelta3(xdelta3Path);
  if (!xdeltaReady && diff.changed.some((item) => item.size > LARGE_FILE_THRESHOLD)) {
    warn('xdelta3 不可用，大文件全部回退为全量覆盖（增量包会变大）');
  }

  // 1) 变更文件：大文件先尝试补丁（生成后立刻回放验证），否则全量。
  // 新增文件没有旧版本可对比，直接全量。生成阶段用唯一临时名，
  // 避免不同目录下的同名文件互相覆盖
  const plannedPatches = [];
  const plannedCopies = [...diff.added];
  for (const item of diff.changed) {
    if (xdeltaReady && item.size > LARGE_FILE_THRESHOLD) {
      const tmpPatchPath = path.join(tmpPatchDir, `${plannedPatches.length}.vcdiff`);
      const result = makeVerifiedPatch({
        xdelta3Path,
        sourcePath: path.join(prevDir, item.path),
        targetPath: path.join(appDir, item.path),
        patchPath: tmpPatchPath,
        targetSha256: item.sha256,
      });
      if (result.ok) {
        plannedPatches.push({ ...item, tmpPatchPath, patchSize: result.patchSize });
        continue;
      }
      warn(`补丁不可用，回退全量：${item.path}（${result.reason}）`);
    }
    plannedCopies.push(item);
  }

  // 2) 补丁文件按冲突规则命名并落位
  const named = assignPatchNames(plannedPatches);
  for (const item of named) {
    fs.renameSync(item.tmpPatchPath, path.join(patchesDir, item.patch));
  }

  const manifestFiles = [];
  let patchBytes = 0;
  for (const item of named) {
    manifestFiles.push({
      path: item.path,
      method: 'xdelta3',
      sha256: item.sha256,
      size: item.size,
      sourceSha256: item.sourceSha256,
      patch: item.patch,
      patchSize: item.patchSize,
    });
    patchBytes += item.patchSize;
  }

  // 3) 新增 + 回退全量的文件：按相对路径镜像到 payload/
  plannedCopies.sort((a, b) => a.path.localeCompare(b.path));
  let copyBytes = 0;
  for (const item of plannedCopies) {
    if (item.path === 'xdelta3.exe' || item.path === 'patches' || item.path.startsWith('patches/')) {
      throw new Error(`文件路径与增量包内部结构冲突：${item.path}`);
    }
    const target = path.join(payloadDir, item.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(appDir, item.path), target);
    manifestFiles.push({
      path: item.path,
      method: 'copy',
      sha256: item.sha256,
      size: item.size,
    });
    copyBytes += item.size;
  }

  // 4) xdelta3.exe 随包分发（调用方通常已放进 payload 根，这里兜底复制）
  const payloadXdelta = path.join(payloadDir, 'xdelta3.exe');
  if (named.length > 0) {
    if (!fs.existsSync(payloadXdelta)) {
      if (!xdeltaReady) throw new Error('存在补丁但 xdelta3 不可用，无法生成安装包');
      fs.copyFileSync(xdelta3Path, payloadXdelta);
    }
  } else {
    fs.rmSync(payloadXdelta, { force: true });
    fs.rmSync(patchesDir, { recursive: true, force: true });
  }

  // 5) delta-files.nsh（带 BOM：makensis 对无 BOM 的 UTF-8 按 ANSI 解析）
  const deltaData = path.join(outDir, 'delta-files.nsh');
  fs.writeFileSync(deltaData, BOM + renderDeltaNsh(manifestFiles, diff.removed), 'utf8');

  // 6) manifest（packageSha256 待安装包编译后回填）
  const packageName = `delta-update-${version}-${arch}.exe`;
  const manifestName = `delta-update-${version}-${arch}.json`;
  const manifest = {
    schema: 1,
    version,
    fromVersion,
    arch,
    package: packageName,
    packageSha256: '',
    fullSetup: `FFGui-${version}-${arch}-Setup.exe`,
    files: manifestFiles,
    removed: diff.removed,
  };
  writeManifests({ outDir, manifest, manifestName });

  const copyCount = manifestFiles.filter((file) => file.method === 'copy').length;
  const patchCount = manifestFiles.filter((file) => file.method === 'xdelta3').length;
  log(
    `delta 构成：补丁 ${patchCount} 个（${formatMB(patchBytes)}）、` +
      `全量 ${copyCount} 个（${formatMB(copyBytes)}）、删除 ${diff.removed.length} 个、` +
      `未变 ${diff.unchanged.length} 个`
  );

  // 7) 编译安装包并回填 packageSha256
  let outFile = path.join(outDir, packageName);
  if (compile) {
    const defines = buildDefines({
      outFile,
      version,
      fromVersion,
      payloadDir,
      deltaData,
      hasPatches: patchCount > 0,
    });
    compileDeltaInstaller({ outFile, defines });
    manifest.packageSha256 = sha256File(outFile);
    writeManifests({ outDir, manifest, manifestName });
    log(`完成：${outFile}（${formatMB(fs.statSync(outFile).size)}）`);
  } else {
    warn('--no-compile：跳过安装包编译，manifest.packageSha256 留空');
    outFile = '';
  }
  fs.rmSync(tmpPatchDir, { recursive: true, force: true });
  log(`清单：${path.join(outDir, manifestName)}`);
  return { diff, manifest, manifestPath: path.join(outDir, manifestName), outFile };
}

function formatMB(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function parseArgs(argv) {
  const options = { compile: true };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--app-dir') options.appDir = argv[++i];
    else if (key === '--prev-dir') options.prevDir = argv[++i];
    else if (key === '--xdelta3') options.xdelta3Path = argv[++i];
    else if (key === '--out-dir') options.outDir = argv[++i];
    else if (key === '--arch') options.arch = argv[++i];
    else if (key === '--version') options.version = argv[++i];
    else if (key === '--from-version') options.fromVersion = argv[++i];
    else if (key === '--no-compile') options.compile = false;
    else throw new Error(`未知参数：${key}`);
  }
  if (!options.appDir || !options.prevDir || !options.outDir) {
    throw new Error(
      '缺少必填参数：--app-dir <新目录> --prev-dir <旧目录> --out-dir <输出目录>'
    );
  }
  if (!options.arch) throw new Error('缺少 --arch <x64|arm64>');
  if (!options.version) throw new Error('缺少 --version <新版>');
  if (!options.fromVersion) throw new Error('缺少 --from-version <旧版>');
  options.appDir = path.resolve(options.appDir);
  options.prevDir = path.resolve(options.prevDir);
  options.outDir = path.resolve(options.outDir);
  return options;
}

if (require.main === module) {
  try {
    buildDelta(parseArgs(process.argv.slice(2)));
  } catch (err) {
    console.error(`${LOG_PREFIX} 失败：${err.message}`);
    process.exit(1);
  }
}

module.exports = {
  scanDiff,
  listFiles,
  sha256File,
  probeXdelta3,
  applyPatch,
  makeVerifiedPatch,
  assignPatchNames,
  renderDeltaNsh,
  buildDelta,
  parseArgs,
  LARGE_FILE_THRESHOLD,
};
