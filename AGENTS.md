# AGENTS.md

本文件面向 AI 编码代理，假设读者对本项目一无所知。

## 项目概览

FFGui 是一个基于 Electron 的桌面音视频工具箱（GUI for FFmpeg），个人开源项目（LGPL-3.0-or-later），界面语言为简体中文。已实现「音视频转码」和「音视频合并」；首页上的「音视频截取」为占位入口，点击后显示"功能开发中"。

应用通过项目内置的 `bin/ffmpeg.exe` 执行实际转码：主进程负责探测 ffmpeg 能力（硬件加速 / 编码器 / 封装格式）并缓存、弹文件对话框、spawn ffmpeg 子进程并解析其 `-progress` 输出；渲染进程为纯静态 HTML/CSS/JS 页面。

## 技术栈

- Electron 41（`package.json` 中 `devDependencies.electron`），CommonJS（`"type": "commonjs"`）
- 无前端框架、无打包器、无 TypeScript：渲染层就是原生 HTML + CSS + ES5 风格 IIFE 脚本
- 打包工具：Electron Forge 7（`forge.config.js`），makers：Squirrel（Windows）、zip（macOS）、deb/rpm（Linux）
- `.npmrc` 配置了 npmmirror 的 Electron 镜像（`electron_mirror`），安装依赖在国内网络下进行

## 目录结构与模块划分

```
index.js            主进程入口：创建 BrowserWindow（1080x720，contextIsolation: true，
                    nodeIntegration: false），app ready 后调用 main/ffmpeg.registerIpc()
main/ffmpeg.js      主进程核心：
                    - 能力探测：运行 ffmpeg -version/-hwaccels/-encoders/-formats，
                      解析输出并缓存到 userData/ffmpeg-caps.json（CACHE_VERSION = 3，
                      解析逻辑变更时需递增此版本号使旧缓存失效）
                    - 硬件编码器实测：首次探测时对 *_nvenc/_qsv/_amf/_mf/_vaapi/_vulkan
                      等硬件编码器各试编码 1 帧（256x256，过小会触发最小分辨率限制
                      造成误判）到 null 设备，失败者在编码器条目上标 broken: true，
                      转码页下拉框会剔除；首页"清除硬件信息缓存"按钮可删除缓存重新探测
                    - 转码任务：spawn ffmpeg，参数含 -nostats -progress pipe:1，
                      解析 stdout 的 key=value 进度块，通过 'ffgui:convert-event'
                      推送 file-start / progress / file-done / file-error 事件
                      （spawn/日志/进度解析封装在 runFfmpegTask，转码与合并共用）
                    - 合并任务：probeFile 用 ffmpeg -i 的 stderr 探测流信息（时长/
                      有无音视频流/分辨率，attached pic 封面不算视频流）；混合队列用
                      concat filter 重编码拼接，纯音频段生成等长黑屏（color 源）、
                      无音轨视频段生成静音（anullsrc）；纯音频队列 concat v=0 只拼音频
                    - IPC handler：ffgui:getCapabilities / clearCapsCache /
                      pickMediaFiles / pickDirectory / convert / cancelConvert /
                      probeMedia / merge（合并的进度与取消复用 convert 的事件与 IPC）
preload/preload.js  通过 contextBridge 暴露 window.ffgui（getCapabilities、clearCapsCache、
                    pickMediaFiles、pickDirectory、getPathForFile、convert、cancelConvert、
                    onConvertEvent、probeMedia、merge）
html/index.html     首页（功能导航卡片），clip 为占位视图
html/convert.html   转码页
html/merge.html     合并页（队列拖动排序、混合队列黑屏段拼接）
html/js/index.js    首页视图切换逻辑
html/js/convert.js  转码页全部逻辑：候选格式/编码器清单是硬编码的，但会按主进程
                    探测到的真实能力过滤后填充下拉框
html/js/merge.js    合并页全部逻辑
html/css/style.css  全部页面共用样式
bin/ffmpeg.exe      内置的 ffmpeg 可执行文件（仅 Windows）；开发时从项目根 bin/ 加载，
                    打包时经 extraResource 复制到 resources/bin/（main/ffmpeg.js 的
                    getFfmpegPath 按 app.isPackaged 区分两条路径）。
                    macOS 不内置 ffmpeg，使用 Homebrew 安装的系统 ffmpeg
                    （依次探测 /opt/homebrew/bin/ffmpeg、/usr/local/bin/ffmpeg、PATH；
                    未安装时提示 brew install ffmpeg）；Linux 走系统 PATH 的 ffmpeg
test_media/         手工测试用的示例音视频文件（不进入安装包）
forge.config.js     Electron Forge 配置
```

## 构建与运行命令

- `npm start` — 开发运行（`electron-forge start`）
- `npm run package` — 打包到 `out/FFGui-win32-x64/`（packageAfterCopy 钩子会压缩 JS/HTML/CSS）
- `npm run make` — 生成安装包（Windows 为 Squirrel）

没有测试框架、没有 lint/format 配置、没有 CI、没有 git 仓库（项目目录下无 `.git`）。

## 代码约定

- 全部注释与界面文案使用简体中文，提交/文档同样使用中文
- 主进程/preload 为 CommonJS `require`；渲染进程脚本是无模块的 IIFE（HTML 有 CSP：
  `default-src 'self'; style-src 'self'; script-src 'self'`，禁止内联脚本与远程资源）
- 渲染进程不得直接访问 Node API，一切跨进程能力走 `window.ffgui`（preload contextBridge）
- ffmpeg 的日志走 stderr、进度走 stdout（`-progress pipe:1`），主进程按行解析；
  新增转码功能时应复用 `main/ffmpeg.js` 中的 spawn/解析模式
- 输出文件名规则：与源文件同目录同格式时自动加 `_ffgui` 后缀避免覆盖源文件
  （`main/ffmpeg.js` 的 `buildOutputPath`）

## 安全注意事项

- 保持 `contextIsolation: true`、`nodeIntegration: false`；新增 IPC 时只在 preload 中暴露最小 API
- forge.config.js 中启用了 Electron Fuses（RunAsNode: false、OnlyLoadAppFromAsar: true 等），不要为图方便关闭
- HTML 中的 CSP meta 不要放宽

## 已知问题

- 未配置应用图标（`packagerConfig.icon`），打包产物使用 Electron 默认图标；如需自定义，
  准备 `assets/imgs/favicon.ico`（或 .png/.icns）后在 `forge.config.js` 中配置
- 打包体积较大：`bin/ffmpeg.exe` 约 110MB，经 `extraResource` 原样分发且不进 asar，
  `packagerConfig.ignore` 中的 `/^\/bin($|\/)/` 规则不要删除，否则 asar 里会再塞一份；
  `extraResource` 按构建平台条件配置，仅在 Windows 携带 `bin/`
- `package.json` 中 `allowScripts` 字段是非 npm 标准字段（模板残留），当前无实际作用

## 测试方式

无自动化测试。手工验证方式：`npm start` 启动应用，使用 `test_media/` 下的示例文件走一遍
转码流程（含拖拽添加、取消、进度显示），并在主进程控制台观察 `[ffgui]` / `[ffmpeg]` 日志。
