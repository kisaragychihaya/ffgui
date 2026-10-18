// 编译 NSIS 安装包：调用仓库内置的 NSISBI（tools/nsisbi，免安装版）
//
// 用法：
//   node scripts/build-installer.cjs --app-dir <打包目录> [--out-dir <输出目录>] [--arch <x64|arm64>]
//
// 也作为模块被 makers/nsis.js（Electron Forge 自定义 maker）调用。
// 安装包名称/路径规则（AGENTS.md）：桌面与开始菜单快捷方式为「狒狒格式工具箱」，
// 安装包文件名为 FFGui-<版本>[-arm64]-Setup.exe。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const APP_NAME = '狒狒格式工具箱';
const APP_ID = 'ffgui';
const APP_URL = 'https://github.com/kisaragychihaya/ffgui';
const PUBLISHER = 'kisaragychihaya';

// NSISBI 编译器不入库：首次构建时从 Release 资源下载解压到 tools/nsisbi/
// （zip 由 SourceForge nsisbi-3.12.2-amd64.zip 裁剪打包，见 tools/nsisbi/README.md）
const NSISBI_VERSION = '3.12.2';
const NSISBI_URL = `${APP_URL}/releases/download/v0.1/nsisbi-${NSISBI_VERSION}-amd64-trimmed.zip`;

// 确保 NSISBI 编译器就位；已存在则直接使用，否则下载并解压
function ensureNsisbi(nsisbiDir) {
  const makensis = path.join(nsisbiDir, 'makensis.exe');
  if (fs.existsSync(makensis)) return makensis;
  console.log(`[installer] 未找到 NSISBI，从 Release 资源下载：${NSISBI_URL}`);
  fs.mkdirSync(nsisbiDir, { recursive: true });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffgui-nsisbi-dl-'));
  const tmpZip = path.join(tmpDir, 'nsisbi.zip');
  try {
    // curl.exe 随 Windows 10 1803+ 提供且支持 HTTPS_PROXY；GitHub Actions 可直接访问
    const dl = spawnSync('curl.exe', ['-fL', '--retry', '3', '-o', tmpZip, NSISBI_URL], {
      encoding: 'utf8',
    });
    if (dl.status !== 0 || !fs.existsSync(tmpZip)) {
      throw new Error(`NSISBI 下载失败（退出码 ${dl.status}）：${NSISBI_URL}\n${(dl.stderr || '').trim()}`);
    }
    // 用系统 bsdtar（Windows 10 1803+ 自带，可直接解压 zip）的绝对路径调用：
    // PATH 里 Git 的 GNU tar 会抢先且不认 zip；路径用正斜杠，盘符冒号会被当成 host:path 远程语法
    const bsdtar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    const ex = spawnSync(bsdtar, ['-xf', tmpZip.replace(/\\/g, '/'), '-C', nsisbiDir.replace(/\\/g, '/')], { encoding: 'utf8' });
    if (ex.status !== 0) {
      throw new Error(`NSISBI 解压失败：${(ex.stderr || '').trim()}`);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  if (!fs.existsSync(makensis)) {
    throw new Error(`解压后未找到 ${makensis}，可能压缩包内容变更`);
  }
  console.log(`[installer] NSISBI 就绪：${nsisbiDir}`);
  return makensis;
}

// NSISBI 的 makensis 打不开正斜杠的 !include / 编译期文件路径（原版 NSIS 可以），
// 统一转成 Windows 反斜杠；NSIS 字符串中反斜杠没有转义含义，路径可安全使用
const BOM = '﻿';
function toNsisPath(p) {
  return p.replace(/\//g, '\\');
}

function makeViVersion(version) {
  // VIProductVersion 需要四段数字（去掉预发布后补 .0）
  const parts = version.split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  while (parts.length < 4) parts.push(0);
  return parts.slice(0, 4).join('.');
}

function build({ appDir, outDir, arch }) {
  if (process.platform !== 'win32') {
    throw new Error('NSIS 安装包只能在 Windows 上构建（当前平台：' + process.platform + '）');
  }
  const packageJSON = require(path.join(ROOT, 'package.json'));
  const version = packageJSON.version;
  const appExe = `${packageJSON.productName}.exe`; // FFGui.exe

  appDir = path.resolve(appDir);
  outDir = path.resolve(outDir || path.join(ROOT, 'out', 'make', 'nsis', arch || process.arch));

  const nsisbiDir = path.join(ROOT, 'tools', 'nsisbi');
  const makensis = ensureNsisbi(nsisbiDir);
  const script = path.join(ROOT, 'assets', 'installer.nsi');
  const iconFile = path.join(ROOT, 'assets', 'imgs', 'icon.ico');
  const licenseFile = path.join(ROOT, 'LICENSE');

  for (const [label, p] of [
    ['安装脚本', script],
    ['图标', iconFile],
    ['许可证文件', licenseFile],
  ]) {
    if (!fs.existsSync(p)) throw new Error(`${label}不存在：${p}`);
  }
  if (!fs.existsSync(path.join(appDir, appExe))) {
    throw new Error(`打包目录中未找到 ${appExe}：${appDir}（请先 npm run package）`);
  }

  fs.mkdirSync(outDir, { recursive: true });
  // 文件名始终带架构标识，避免 x64/arm64 安装包混淆
  const suffix = arch === 'arm64' ? '-arm64' : '-x64';
  const outFile = path.join(outDir, `FFGui-${version}${suffix}-Setup.exe`);

  // 中文产品名等含非 ASCII 字符，写入 defines.nsh 时带 UTF-8 BOM（NSIS Unicode 解析需要）。
  // 界面文案（主程序/卸载/运行/品牌行）已改为 installer.nsi 里的 LangString，按语言自动选择
  const defines = [
    `!define APP_NAME "${APP_NAME}"`,
    `!define APP_ID "${APP_ID}"`,
    `!define APP_VERSION "${version}"`,
    `!define APP_EXE "${appExe}"`,
    `!define APP_PUBLISHER "${PUBLISHER}"`,
    `!define APP_URL "${APP_URL}"`,
    `!define APP_DIR "${toNsisPath(appDir)}"`,
    `!define OUT_FILE "${toNsisPath(outFile)}"`,
    `!define LICENSE_FILE "${toNsisPath(licenseFile)}"`,
    `!define ICON_FILE "${toNsisPath(iconFile)}"`,
    `!define UNINSTALL_EXE "uninstall.exe"`,
    // 版本信息里只有一份字符串（无法按语言本地化），用中英混排兼顾
    `!define FILE_DESCRIPTION "${APP_NAME} (FFGui) Setup"`,
    `!define LEGAL_COPYRIGHT "Copyright (C) ${new Date().getFullYear()} ${PUBLISHER} · LGPL-3.0-or-later"`,
    `!define ORIGINAL_FILENAME "${path.basename(outFile)}"`,
    `!define VI_VERSION "${makeViVersion(version)}"`,
  ].join('\r\n');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffgui-nsis-'));
  const definesFile = path.join(tmpDir, 'defines.nsh');
  fs.writeFileSync(definesFile, BOM + defines, 'utf8');
  // installer.nsi 含中文注释，而 makensis 把无 BOM 文件按 ANSI 解析（报 Bad text encoding），
  // 因此把脚本复制到临时目录并补 UTF-8 BOM 后再编译；错误信息中的行号与原文件一致
  const scriptTmp = path.join(tmpDir, 'installer.nsi');
  fs.writeFileSync(scriptTmp, BOM + fs.readFileSync(script, 'utf8'), 'utf8');

  console.log(`[installer] makensis 编译中：${outFile}`);
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
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (_) {
    // 临时目录清理失败不影响产物
  }
  if (!fs.existsSync(outFile)) {
    throw new Error(`makensis 报告成功但未生成安装包：${outFile}`);
  }
  const sizeMB = (fs.statSync(outFile).size / 1024 / 1024).toFixed(1);
  console.log(`[installer] 完成：${outFile}（${sizeMB} MB）`);
  return outFile;
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--app-dir') opts.appDir = argv[++i];
    else if (key === '--out-dir') opts.outDir = argv[++i];
    else if (key === '--arch') opts.arch = argv[++i];
    else throw new Error(`未知参数：${key}`);
  }
  return opts;
}

if (require.main === module) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (!opts.appDir) {
      throw new Error('缺少 --app-dir <打包目录>（如 out/FFGui-win32-x64）');
    }
    build({ appDir: opts.appDir, outDir: opts.outDir, arch: opts.arch });
  } catch (err) {
    console.error(`[installer] 失败：${err.message}`);
    process.exit(1);
  }
}

module.exports = { build };
