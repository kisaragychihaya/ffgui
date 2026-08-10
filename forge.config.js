const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');
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

module.exports = {
  hooks: {
    // packageAfterCopy 在文件被复制到临时打包目录后触发，
    // buildPath 是包含应用代码的临时目录路径
    packageAfterCopy: async (forgeConfig, buildPath) => {
      console.log('正在压缩 JS / HTML / CSS 文件...', buildPath);
      await minifyFiles(buildPath);
      console.log('压缩完成！');
    },
  },

  packagerConfig: {
    asar: true,
    // CI 无 Apple 开发者证书，macOS 打包跳过签名（本地有证书可移除此项自动签名）
    osxSign: { identity: null },
    // Windows 内置 bin/ffmpeg.exe 是独立可执行文件，无法从 asar 内 spawn，
    // 作为额外资源复制到 resources/bin/（main/ffmpeg.js 中会区分开发/打包路径）；
    // macOS / Linux 使用系统 ffmpeg（Homebrew 等），不携带 bin/
    extraResource: process.platform === 'win32' ? ['./bin/'] : [],
    ignore: [
      /^\/out($|\/)/,
      /^\/test_media($|\/)/,
      // bin 由 extraResource 提供，不进 asar
      /^\/bin($|\/)/,
      /^\/\.idea($|\/)/,
      /^\/\.git($|\/)/,
      /^\/\.agents($|\/)/,
      // 纯开发用途的文件/目录，运行时无引用，不打入安装包
      /^\/scripts($|\/)/,
      /^\/docs($|\/)/,
      /^\/README\.md$/,
      /^\/AGENTS\.md$/,
      /^\/\.gitignore$/,
      /^\/\.npmrc$/,
      /^\/forge\.config\.js$/,
    ],
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {},
    },
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
