# AGENTS.md

面向 AI 编码代理的项目说明，读者对本项目一无所知。本文只放每次改动都要遵守的约束与速查；架构细节、构建发布、测试与已知问题按主题拆在 `docs/` 下（索引见文末），改动涉及对应内容时同步更新子文档。

## 项目概览

FFGui 是基于 Electron 的桌面音视频工具箱（GUI for FFmpeg），LGPL-3.0-or-later，界面多语言（zh-CN 为源文案）。七个功能：音视频转码、合并、截取（无损切 + 抓帧）、画面裁剪（可视化画框）、屏幕录制、光盘抓取（DVD/蓝光）、CD 抓轨（音乐 CD → FLAC）；其中光盘抓取与 CD 抓轨共用一个入口页（disc.html 手动选类型动态切换，结构见 docs/architecture.md）。

内置 ffmpeg 在主进程完成实际处理：能力探测（硬件加速/编码器/封装，带缓存）、文件对话框、spawn 子进程解析 `-progress`；渲染进程是纯静态 HTML/CSS/JS（原生 IIFE，无框架/无 TS/无打包器）。录屏采集与编码在渲染进程（系统选择器 + MediaRecorder），仅结果转 MP4 走 ffmpeg。

- Electron 41、CommonJS、Node 22（CI）；打包用 Electron Forge 7（Windows NSIS / macOS zip / Linux deb+rpm）
- `.npmrc` 配 npmmirror 镜像；JS/HTML/CSS 压缩由 `packageAfterCopy` 钩子执行

## 目录地图（速览）

- `index.js` + `main/*.js` — 主进程：ffmpeg.js 核心（探测/转码/合并/截取/录屏），disc.js + Rust 侧车（光盘），cdrip.js（CD），dub.js（TTS 配音），theme.js / i18n.js
- `preload/preload.js` — contextBridge，渲染层唯一能力入口 `window.ffgui`，新增 IPC 只暴露最小 API
- `html/` — 渲染层页面与脚本；`locales/` — 五语言词典；每个页面最先加载 `html/js/i18n.js` 再 `theme.js`
- `native/` — Rust 光盘侧车（ffgui-disc）与 TTS 引擎源码子模块（qwentts.cpp，需 --recurse-submodules）
- `bin/` — 内置 ffmpeg / 侧车 / TTS / aria2c 二进制（打包经 extraResource 分发且不进 asar；`bin/aria2/aria2c.exe` 仅 Windows x64，供模型下载断点续传，来源与布局见 `bin/README.md`）；`assets/` 图标 + NSIS 脚本；`scripts/`、`makers/`、`tools/`、`forge.config.js` — 构建与打包

逐文件职责、IPC 清单、协议与实现细节见 **docs/architecture.md**。

## 代码约定（每条都强制）

1. 全部注释、提交、文档使用简体中文；**界面文案不得硬编码，一律走词典**（规则见下节 i18n）
2. 主进程/preload 为 CommonJS `require`；渲染进程脚本是无模块 IIFE；HTML 的 CSP 不要放宽
3. 渲染进程不得直接访问 Node API，一切跨进程能力走 `window.ffgui`（preload contextBridge）
4. ffmpeg 日志走 stderr、进度走 stdout（`-progress pipe:1`）按行解析；新增转码功能复用 `runFfmpegTask` 的 spawn/解析模式（main/ffmpeg.js）
5. 输出命名：与源同目录同格式自动加 `_ffgui` 后缀（buildOutputPath）；合并固定 `merged_<时间戳>`；录屏固定 `record_<时间戳>.webm`；转码/合并/截取传 `-n`，不要改回无条件 `-y`

## 安全注意事项

- 保持 `contextIsolation: true`、`nodeIntegration: false`；新增 IPC 只在 preload 暴露最小 API
- forge.config.js 的 Electron Fuses 不要关闭
- 打包后禁止打开 DevTools（index.js 拦截 devtools-opened）

## 界面多语言（i18n）要点

- 词典 `locales/<lng>.json`（zh-CN / zh-TW / en / ja / ko），键用点路径 + `{{var}}` 插值；五语言键集合与每键占位符必须完全一致，**不得留死键**（每个 key 必须被 HTML/JS/主进程真实引用），`scripts/i18n.test.cjs` 强制校验
- 静态文案标 `data-i18n="ns.key"`（元素含 SVG/子元素时标内部文本节点或包 `<span>`，不标父元素）、属性标 `data-i18n-attr`、页面标题标 `<html data-i18n-title>`；动态文案一律 `t()`，重绘路径与 `window.i18n.onChange(...)` 回调里必须重刷（已生成的日志行不回溯翻译）
- 主进程文案用 `t('main.…')`；`console.log` 开发日志保持中文；错误码字面量（`FFGUI_*`）不得翻译
- 新增 key：先写 zh-CN 再补齐其余四种，改完跑 `node --test scripts/i18n.test.cjs`
- **安装包界面是另一套**：`assets/installer.nsi` 用 NSIS `LangString` + `MUI_LANGUAGE`，五语言、按系统显示语言自动选、English 放最前兜底；**卸载段名必须字面量 `Section "Uninstall"`**（NSIS 仅凭段名识别卸载器，改名会装完即删，v0.6.1 翻车过）

## 构建与测试速查

- `npm install` / `npm start`（开发）/ `npm run package` / `npm run make`（NSIS 安装包）
- `npm test` — regression + i18n + cdrip + cd-ui（需 PATH 有 ffmpeg/ffprobe 或 `FFMPEG` / `FFPROBE` 环境变量）
- 光盘侧车与页面专项：`node --test scripts/disc.test.cjs scripts/disc-sidecar.test.cjs scripts/disc-ui.test.cjs`；Rust 侧车 `cd native/ffgui-disc && cargo test --locked`
- TTS 引擎编译：`node scripts/build-tts.cjs [--backend vulkan|cpu] [--arch x64|arm64] [--no-native]`（分发构建必须 `--no-native`）
- 发布与 CI 细节见 **docs/build-release.md**；测试体系、手工验证清单、已知限制见 **docs/testing.md**

## 关键陷阱（历史翻车点，改打包/CI/i18n 前必读）

- `packagerConfig.ignore` 的 `/^\/bin($|\/)/`、`/^\/tools($|\/)/` 等规则**不要删**：删 bin 规则 asar 会再塞一份 ffmpeg，漏排 tools/ 会把 377 个 NSISBI 文件打进包（asar 447 → 63 的教训）；CI 新增解压步骤不要往仓库根目录留大目录（workflow 用 `$RUNNER_TEMP`，ignore 兜底 `/^\/ffmpeg-.*/`）
- forge.config.js 不能出现 null 值（proxify 会崩溃）
- 多语言改动后 `npm start` 逐页切换五种语言核对（含主进程报错与文件对话框标题）
- 应用图标命名须与 `packagerConfig.icon` 一致（icon.png / icon.ico / icon.icns）
- macOS 内置 ffmpeg 必须带 `--enable-libcdio`（CD 抓轨读 TOC 依赖）；bin/bin/ffmpeg 与 bin/lib/ 相对布局不能拆开

## 文档索引

| 文件 | 内容 |
|---|---|
| docs/architecture.md | 目录结构逐文件明细、preload API 全清单、main/ffmpeg.js 要点（能力探测/设备预设/合并/截取/录屏）、音轨与输出规则 |
| docs/build-release.md | 构建命令、TTS 引擎编译、三平台 CI 流程、NSIS 安装器多语言细节 |
| docs/testing.md | 测试文件清单与 vm/mock 加载模式、手工验证清单、已知问题与平台限制（体积/录屏/光盘/CD/dub） |
