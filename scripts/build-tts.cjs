// 编译 TTS 引擎 tts-server（native/qwentts.cpp 子模块）并拷贝到 bin/tts/
//
// 用法：
//   node scripts/build-tts.cjs [--backend vulkan|cpu] [--arch x64|arm64] [--no-native] [--clean]
//
//   --backend  计算后端，默认按平台自动选：Windows x64 = Vulkan（主力），
//              macOS / Windows arm64 / Linux = CPU
//   --arch     目标架构，默认主机架构；Windows 传 arm64 时交叉编译（Vulkan 交叉不可用）
//   --no-native 关掉 -march=native 之类的宿主优化，产物可分发到其他机器
//   --clean    先删掉子模块的 build/ 目录再配置
//
// 前置：cmake（3.19+，Vulkan 后端由 ggml/src/ggml-vulkan/CMakeLists.txt 要求）；
// Vulkan 后端还需要完整 Vulkan SDK（该文件 find_package(Vulkan COMPONENTS glslc REQUIRED)
// + find_package(SPIRV-Headers CONFIG REQUIRED)，并读取 VULKAN_SDK 环境变量）。
// Windows 上用默认生成器（Visual Studio），macOS/Linux 用默认生成器（Makefiles/Ninja）。
//
// 产物位置：native/qwentts.cpp/CMakeLists.txt 把 CMAKE_RUNTIME_OUTPUT_DIRECTORY 指向
// 构建根目录，因此单配置生成器产出 <build>/tts-server(.exe)，多配置（VS）产出
// <build>/Release/tts-server(.exe)（各后端若是动态库则同目录）。两种布局都兼容。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SUBMODULE_DIR = path.join(ROOT, 'native', 'qwentts.cpp');
const BUILD_DIR = path.join(SUBMODULE_DIR, 'build');
const OUT_DIR = path.join(ROOT, 'bin', 'tts');
const EXE_NAME = process.platform === 'win32' ? 'tts-server.exe' : 'tts-server';
// Vulkan 构建时 ggml 的 shader 编译需要 cmake 3.19+（ggml-vulkan 的 cmake_minimum_required）
const CMAKE_MIN_FOR_VULKAN = [3, 19];

function fail(msg) {
  console.error(`[tts] 错误：${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = { backend: null, arch: process.arch === 'arm64' ? 'arm64' : 'x64', noNative: false, clean: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const takeValue = () => {
      const v = argv[i + 1];
      if (!v || v.startsWith('--')) fail(`${arg} 缺少取值`);
      i += 1;
      return v;
    };
    if (arg === '--backend') opts.backend = takeValue();
    else if (arg.startsWith('--backend=')) opts.backend = arg.slice('--backend='.length);
    else if (arg === '--arch') opts.arch = takeValue();
    else if (arg.startsWith('--arch=')) opts.arch = arg.slice('--arch='.length);
    else if (arg === '--no-native') opts.noNative = true;
    else if (arg === '--clean') opts.clean = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('用法：node scripts/build-tts.cjs [--backend vulkan|cpu] [--arch x64|arm64] [--no-native] [--clean]');
      process.exit(0);
    } else fail(`未知参数：${arg}`);
  }
  if (opts.backend && opts.backend !== 'vulkan' && opts.backend !== 'cpu') {
    fail(`--backend 只能是 vulkan 或 cpu，收到：${opts.backend}`);
  }
  if (opts.arch !== 'x64' && opts.arch !== 'arm64') {
    fail(`--arch 只能是 x64 或 arm64，收到：${opts.arch}`);
  }
  if (!opts.backend) opts.backend = defaultBackend(opts.arch);
  return opts;
}

// 默认后端：Windows x64 用 Vulkan（主力，装 Vulkan SDK 即可），
// macOS 只做 CPU（Metal 由 ggml 在 APPLE 下默认开启，MoltenVK 暂不涉及），
// Windows arm64 交叉编译 Vulkan 工具链不稳，也只做 CPU
function defaultBackend(arch) {
  if (process.platform === 'win32' && arch === 'x64') return 'vulkan';
  return 'cpu';
}

function run(cmd, args, options = {}) {
  console.log(`[tts] ${cmd} ${args.join(' ')}`);
  const res = spawnSync(cmd, args, { stdio: 'inherit', cwd: options.cwd || ROOT });
  if (res.error) {
    if (res.error.code === 'ENOENT') return { missing: true, status: -1 };
    fail(`${cmd} 执行失败：${res.error.message}`);
  }
  return { status: res.status === null ? -1 : res.status };
}

function requireCmake() {
  const res = spawnSync('cmake', ['--version'], { encoding: 'utf8' });
  if (res.error && res.error.code === 'ENOENT') {
    fail(
      '未找到 cmake，请先安装：\n' +
        '  Windows: https://cmake.org/download/ 或 winget install Kitware.CMake\n' +
        '  macOS:   brew install cmake\n' +
        '  Linux:   sudo apt install cmake build-essential'
    );
  }
  const out = `${res.stdout || ''}${res.stderr || ''}`;
  const m = out.match(/cmake version (\d+)\.(\d+)/);
  if (!m) return;
  const ver = [Number(m[1]), Number(m[2])];
  const tooOldForVulkan = ver[0] < CMAKE_MIN_FOR_VULKAN[0] || (ver[0] === CMAKE_MIN_FOR_VULKAN[0] && ver[1] < CMAKE_MIN_FOR_VULKAN[1]);
  return { version: `${m[1]}.${m[2]}`, tooOldForVulkan };
}

// 递归查找产物：优先常见位置，找不到时兜底全目录搜索（生成器布局变化时不至于失败）
function findProduct() {
  const direct = [
    path.join(BUILD_DIR, EXE_NAME),
    path.join(BUILD_DIR, 'Release', EXE_NAME),
    path.join(BUILD_DIR, 'bin', EXE_NAME),
    path.join(BUILD_DIR, 'bin', 'Release', EXE_NAME),
  ];
  for (const p of direct) {
    if (fs.existsSync(p)) return p;
  }
  let found = null;
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        // CMakeFiles 里只有中间目标，跳过以免拖慢搜索
        if (e.name !== 'CMakeFiles') walk(p);
      } else if (e.name === EXE_NAME && (!found || p.length < found.length)) {
        found = p;
      }
    }
  };
  walk(BUILD_DIR);
  return found;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(path.join(SUBMODULE_DIR, 'CMakeLists.txt'))) {
    fail(
      `未找到子模块 native/qwentts.cpp，先执行：\n` +
        '  git submodule update --init --recursive\n' +
        '（qwentts.cpp 自身还带 ggml 子模块，必须加 --recursive）'
    );
  }

  const cmake = requireCmake();
  if (opts.backend === 'vulkan' && cmake && cmake.tooOldForVulkan) {
    fail(`Vulkan 后端需要 cmake >= ${CMAKE_MIN_FOR_VULKAN.join('.')}，当前为 ${cmake.version}`);
  }
  if (opts.backend === 'vulkan' && process.platform === 'win32' && !process.env.VULKAN_SDK) {
    console.warn('[tts] 警告：未设置 VULKAN_SDK 环境变量，Vulkan 后端通常找不到 glslc/SPIRV-Headers；');
    console.warn('[tts]       请安装 Vulkan SDK（https://vulkan.lunarg.com/sdk/home），或改用 --backend cpu');
  }

  if (opts.clean && fs.existsSync(BUILD_DIR)) {
    console.log(`[tts] 清理构建目录：${BUILD_DIR}`);
    fs.rmSync(BUILD_DIR, { recursive: true, force: true });
  }

  // 配置：Vulkan 开关就是 ggml 的 GGML_VULKAN（见 native/qwentts.cpp/ggml/CMakeLists.txt）
  const configureArgs = [
    '-S', SUBMODULE_DIR,
    '-B', BUILD_DIR,
    '-DCMAKE_BUILD_TYPE=Release',
    `-DGGML_VULKAN=${opts.backend === 'vulkan' ? 'ON' : 'OFF'}`,
  ];
  if (opts.noNative) configureArgs.push('-DGGML_NATIVE=OFF');
  // Windows 交叉编译 ARM64：默认生成器为 Visual Studio，用 -A ARM64 指定目标架构
  if (process.platform === 'win32' && opts.arch === 'arm64') {
    configureArgs.push('-A', 'ARM64');
  }

  const cfg = run('cmake', configureArgs);
  if (cfg.status !== 0) {
    if (opts.backend === 'vulkan') {
      fail(
        'Vulkan 后端配置失败，最常见原因是没装 Vulkan SDK（需要 glslc 与 SPIRV-Headers）：\n' +
          '  Windows: https://vulkan.lunarg.com/sdk/home\n' +
          '  或改用 CPU 后端：node scripts/build-tts.cjs --backend cpu'
      );
    }
    fail('cmake 配置失败，请查看上方输出');
  }

  // 只编译 tts-server 目标，避免连带编译测试/量化工具
  const jobs = String(Math.max(1, os.cpus().length));
  const build = run('cmake', ['--build', BUILD_DIR, '--config', 'Release', '--target', 'tts-server', '-j', jobs]);
  if (build.status !== 0) fail('编译 tts-server 失败，请查看上方输出');

  const product = findProduct();
  if (!product) fail(`编译成功但未找到 ${EXE_NAME}，请检查 ${BUILD_DIR}`);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const target = path.join(OUT_DIR, EXE_NAME);
  fs.copyFileSync(product, target);
  if (process.platform !== 'win32') fs.chmodSync(target, 0o755);

  // 动态后端构建（GGML_BACKEND_DL / BUILD_SHARED_LIBS=ON）会在产物同目录生成
  // ggml*.dll / libggml*.so，运行时按相对路径加载，必须一起带走
  const productDir = path.dirname(product);
  for (const name of fs.readdirSync(productDir)) {
    if (/^(ggml.*\.dll|libggml.*\.so.*)$/.test(name)) {
      fs.copyFileSync(path.join(productDir, name), path.join(OUT_DIR, name));
      console.log(`[tts] 附带动态后端：${name}`);
    }
  }

  const sizeMb = (fs.statSync(target).size / 1024 / 1024).toFixed(1);
  console.log(`[tts] 完成：${path.relative(ROOT, target)}（${sizeMb} MB，后端 ${opts.backend}，架构 ${opts.arch}）`);
}

main();
