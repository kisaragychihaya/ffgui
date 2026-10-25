const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');
// 本地 NSIS maker（tools/nsisbi 内置编译器，见 makers/nsis.js）
const MakerNsis = require('./makers/nsis');
const { minify } = require('terser');
const { minify: minifyHtml } = require('html-minifier-terser');
const CleanCSS = require('clean-css');
const fs = require('fs');
const path = require('path');

// 递归压缩目录下所有 JS / HTML / CSS 文件
async function minifyFiles(dir) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);

    if (stat.isDirectory()) {
      // 排除不需要压缩的目录，如 node_modules
      if (file !== 'node_modules') {
        await minifyFiles(filePath);
      }
    } else if (file.endsWith('.js')) {
      const code = fs.readFileSync(filePath, 'utf8');
      const minified = await minify(code, {
        mangle: true, // 混淆变量名
        compress: true // 压缩代码
      });
      if (minified.code) {
        fs.writeFileSync(filePath, minified.code);
      }
    } else if (file.endsWith('.html')) {
      const code = fs.readFileSync(filePath, 'utf8');
      const minified = await minifyHtml(code, {
        collapseWhitespace: true, // 折叠空白
        removeComments: true, // 移除注释
        minifyCSS: true, // 压缩内联 <style>
        minifyJS: true, // 压缩内联 <script>
      });
      fs.writeFileSync(filePath, minified);
    } else if (file.endsWith('.css')) {
      const code = fs.readFileSync(filePath, 'utf8');
      const minified = new CleanCSS().minify(code);
      if (!minified.errors.length) {
        fs.writeFileSync(filePath, minified.styles);
      }
    }
  }
}

// 精简 Electron 运行时文件（buildPath 为 resources/app，运行时文件在其上两级）
// 界面仅简体中文：裁剪多余语言 pak（约 45MB/55 个）
// dxcompiler/dxil 仅供 WebGPU 使用（应用未用），删除（约 26MB）
// vk_swiftshader 保留：无 GPU 环境（虚拟机/远程桌面）渲染兜底
// LICENSES.chromium.html 是 Chromium 的许可证全文，运行时无引用（约 19MB）；
// 项目自身的 LGPL-3.0 许可证见仓库根 LICENSE，仍随包分发
function trimRuntime(buildPath) {
  const root = path.resolve(buildPath, '..', '..');
  const localesDir = path.join(root, 'locales');
  if (fs.existsSync(localesDir)) {
    for (const f of fs.readdirSync(localesDir)) {
      if (f.endsWith('.pak') && f !== 'zh-CN.pak' && f !== 'en-US.pak') {
        fs.rmSync(path.join(localesDir, f));
      }
    }
  }
  for (const f of ['dxcompiler.dll', 'dxil.dll', 'LICENSES.chromium.html']) {
    const p = path.join(root, f);
    if (fs.existsSync(p)) fs.rmSync(p);
  }
}

// 额外资源清单。bin/tts/（TTS 引擎）可不构建：
// electron-packager 对不存在的 extraResource 路径会直接报错，而未初始化
// native/qwentts.cpp 子模块（或跳过 TTS 构建）时该目录不存在，故按存在与否动态加入，
// 其余条目保持原样（不能出现 null 值，Forge 的 proxify 会崩溃）
function extraResources() {
  if (process.platform === 'linux') return [];
  const list =
    process.platform === 'darwin' ? ['./bin/', './bin/disc/'] : ['./bin/ffmpeg.exe', './bin/disc/'];
  if (fs.existsSync(path.join(__dirname, 'bin', 'tts'))) {
    list.push('./bin/tts/');
  } else {
    console.warn('[ffgui] 未找到 bin/tts/，打包产物不含 TTS 引擎（字幕配音将回退 PATH 查找）');
  }
  return list;
}

module.exports = {
  hooks: {
    // packageAfterCopy 在文件被复制到临时打包目录后触发，
    // buildPath 是包含应用代码的临时目录路径
    packageAfterCopy: async (forgeConfig, buildPath) => {
      console.log('正在压缩 JS / HTML / CSS 文件...', buildPath);
      await minifyFiles(buildPath);
      trimRuntime(buildPath);
      console.log('压缩完成！');
    },
  },

  packagerConfig: {
    asar: true,
    // 应用图标：electron-packager 会根据平台自动追加 .ico / .icns / .png
    icon: path.join(__dirname, 'assets', 'imgs', 'icon'),
    // 不配置 osxSign：electron-packager 默认不签名（CI 无 Apple 证书也可正常打包）。
    // 注意 Forge 配置中不能出现 null 值（proxify 会崩溃），osxSign: { identity: null } 不可用。
    // 内置 bin/ffmpeg.exe（Windows）/ bin/ffmpeg（macOS）是独立可执行文件，
    // 无法从 asar 内 spawn，作为额外资源复制到 resources/bin/
    // （main/ffmpeg.js 中会区分开发/打包路径）；Linux 使用系统 ffmpeg，不携带 bin/
    // Windows 只带 ffmpeg.exe：应用探测与处理全部走 ffmpeg，ffprobe 未被使用
    // （gyan full build 的 ffprobe 与 ffmpeg 一样 140MB+，不携带可省一半 bin 体积）
    // bin/disc/ 是 Rust 光盘侧车，bin/tts/ 是 TTS 引擎 tts-server（native/qwentts.cpp
    // 子模块编译产物），两者都无法从 asar 内 spawn，同样按目录整体作为额外资源分发；
    // Linux 两者都不携带（光盘侧车与 tts-server 均回退系统 PATH）
    extraResource: extraResources(),
    ignore: [
      /^\/out($|\/)/,
      /^\/test_media($|\/)/,
      // bin 由 extraResource 提供，不进 asar
      /^\/bin($|\/)/,
      // CI 在仓库根目录 7z x ffmpeg.7z 的解压残留（ffmpeg-<版本>-full_build/ 等，含
      // ffplay/ffprobe/doc 约 860MB），只从中取 bin/ffmpeg.exe，必须排除
      /^\/ffmpeg-.*($|\/)/,
      /^\/ffmpeg\.7z$/,
      /^\/ffmpeg\.zip$/,
      /^\/\.idea($|\/)/,
      /^\/\.git($|\/)/,
      /^\/\.agents($|\/)/,
      // 纯开发用途的文件/目录，运行时无引用，不打入安装包
      /^\/scripts($|\/)/,
      /^\/docs($|\/)/,
      /^\/README\.md$/,
      /^\/README\.zh\.md$/,
      /^\/AGENTS\.md$/,
      /^\/\.gitignore$/,
      /^\/\.npmrc$/,
      /^\/forge\.config\.js$/,
      // 构建期工具：NSISBI 编译器（tools/nsisbi，约 377 个文件，本机跑过 make 后
      // 才会出现）、NSIS maker 适配层与安装脚本，都只在打包/编译安装包时用，
      // 不进 asar。tools/ 整个排除，避免以后再往 tools/ 放工具时又被打进包
      /^\/tools($|\/)/,
      /^\/makers($|\/)/,
      /^\/assets\/installer\.nsi$/,
      /^\/_cdp_debug\.js$/,
      /^\/\.github($|\/)/,
      // Rust 光盘侧车与 TTS 引擎（native/qwentts.cpp）的源码与构建产物都不进 asar：
      // 二进制由 extraResource 提供，源码是构建期依赖；/^\/bin($|\/)/ 已覆盖
      // bin/disc、bin/tts，下面两条为显式兜底（与既有 bin/disc 保持一致）
      /^\/native($|\/)/,
      /^\/bin\/disc($|\/)/,
      /^\/bin\/tts($|\/)/,
    ],
  },
  rebuildConfig: {},
  makers: [
    // Windows：仓库内置 NSISBI（tools/nsisbi）+ MUI2 现代界面，
    // 含许可证页（须同意，使用项目 LICENSE）与「狒狒格式工具箱」快捷方式，
    // 安装/卸载均无需管理员权限（每用户安装到 %LOCALAPPDATA%\Programs）。
    // 注意必须传实例（new）：Forge 凭实例的 __isElectronForgeMaker 识别自定义 maker
    new MakerNsis(),
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin'],
    },
    {
      name: '@electron-forge/maker-deb',
      config: {},
    },
    {
      name: '@electron-forge/maker-rpm',
      config: {},
    },
  ],
  plugins: [
    {
      name: '@electron-forge/plugin-auto-unpack-natives',
      config: {},
    },
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};
