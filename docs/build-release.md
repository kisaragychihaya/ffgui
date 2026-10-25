# 构建与发布

面向 AI 编码代理的补充文档（由 AGENTS.md 索引）。改动构建流程、CI、安装器时同步更新本文。

## 构建与运行命令

- `npm install` / `npm ci` — 安装依赖
- `npm start` — 开发运行（`electron-forge start`，自动开 DevTools）
- `npm run package` — 打包到 `out/FFGui-win32-x64/`
- `npm run make` — Windows 生成 NSIS 安装包 `FFGui-<版本>-<x64|arm64>-Setup.exe`（MUI2 + 许可证
  页须同意 + 快捷方式「狒狒格式工具箱」，每用户安装无需管理员）
- `node scripts/build-tts.cjs [--backend vulkan|cpu] [--arch x64|arm64] [--no-native] [--clean]` — 编译
  TTS 引擎到 `bin/tts/`（可选：不编则打包时跳过 bin/tts/，字幕配音回退 PATH；需先
  `git submodule update --init --recursive` 与 cmake，Vulkan 后端另需 Vulkan SDK）

`npm test` 用 Node 内置测试运行器（`scripts/regression.test.cjs`），需 PATH 中有 ffmpeg/ffprobe
或设置 `FFMPEG` / `FFPROBE`。没有 lint/format 配置。

## 部署 / CI

`.github/workflows/build.yml`（workflow_dispatch 手动触发或发布 Release 时触发）：

- Windows x64：从 GyanD/codexffmpeg 最新 release 下载 full_build.7z（gyan.dev 直链在 CI 上会被
  反爬拦截），取 `ffmpeg.exe` 放入 `bin/`；dtolnay/rust-toolchain 构建 Rust 侧车并复制为
  `bin/disc/ffgui-disc.exe`；humbletim/install-vulkan-sdk 装 Vulkan SDK 后
  `node scripts/build-tts.cjs --backend vulkan --no-native` 构建 TTS 引擎到 `bin/tts/`
  （Vulkan 失败自动回退 `--backend cpu`，两者都失败只写警告并建空 `bin/tts/`，打包继续）；
  `npm ci` + `npm run package`，再经 `scripts/build-installer.cjs` 生成 NSIS 安装包；
  `FFGui-windows-x64.7z` 与 `FFGui-<版本>-x64-Setup.exe` 上传 artifact；Release 触发时同时
  上传到 Release Assets
- Windows arm64：从 tordona/ffmpeg-win-arm64 最新 release 下载 full-static-win-arm64.7z 取
  `ffmpeg.exe` 放入 `bin/`；安装 Rust ARM64 target、加载 MSVC ARM64 环境并准备 clang（ring 的
  ARM64 汇编需要），`cargo build --target aarch64-pc-windows-msvc` 产出 `bin/disc/ffgui-disc.exe`
  并校验 PE 头机器类型（0xAA64）；x64 runner 无法执行 arm64 二进制；TTS 引擎只做
  `--backend cpu --arch arm64`（Vulkan 交叉构建的工具链不稳，VS 生成器另加 `-A ARM64`）并同样
  校验 0xAA64；`npm run package -- --arch=arm64` 交叉打包，产物 `FFGui-windows-arm64.7z` +
  `FFGui-<版本>-arm64-Setup.exe`（NSIS 安装器架构无关，由 x64 makensis 交叉编译 arm64 内容）
- macOS：下载 kisaragychihaya/ffmpeg_build_mac 最新 release 的 macos-arm64-static tar.gz，
  `bin/` 与 `lib/` 原样放入项目 `bin/` 并 `chmod +x`；cargo 构建侧车到 `bin/disc/ffgui-disc`；
  `node scripts/build-tts.cjs --backend cpu --no-native` 构建 tts-server 到 `bin/tts/`（Metal
  由 ggml 在 APPLE 下默认开启，MoltenVK 暂不涉及）；打包后用 ditto 压缩为
  `FFGui-macos-arm64.zip`；Release 触发时同样上传。
  **CD 抓轨要求该构建带 `--enable-libcdio`**（工作流 configure 里显式开启，未开则
  macOS 上读不出 CD 的 TOC）
- TTS 引擎：源码是 submodule `native/qwentts.cpp`，三个 job 的 checkout 都必须是
  `submodules: recursive`（qwentts.cpp 内部还套着 ggml 子模块，缺了 cmake 配置会直接失败）；
  二进制不入库，每平台按上面的后端现编。Windows x64 的 CPU/Vulkan 构建与 `bin/tts/` 产物布局
  已在本机实测（产物为 `build/Release/tts-server.exe` + 同目录 `ggml*.dll`，tts-server 需与
  dll 同目录才能启动）；**仍未验证**的是 Windows arm64 的 `-A ARM64` 交叉、macOS 构建，以及
  CI 里 Vulkan SDK action 的版本/输入名与 glslc 可用性
- 仓库不提交 `bin/ffmpeg.exe` 等大文件，CI 每次现下；NSISBI 编译器同样不入库，构建时从 v0.1
  Release 资源下载解压
