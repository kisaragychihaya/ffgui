# AGENTS.md

本文件面向 AI 编码代理，假设读者对本项目一无所知。

## 项目概览

FFGui 是一个基于 Electron 的桌面音视频工具箱（GUI for FFmpeg），个人开源项目（LGPL-3.0-or-later），界面语言为简体中文。已实现三个功能：「音视频转码」「音视频合并」「音视频截取」（无损切 + 抓帧截图）。

应用通过项目内置的 ffmpeg 执行实际处理：主进程负责探测 ffmpeg 能力（硬件加速 / 编码器 / 封装格式）并缓存、弹文件对话框、spawn ffmpeg 子进程并解析其 `-progress` 输出；渲染进程为纯静态 HTML/CSS/JS 页面。

## 技术栈

- Electron 41（`package.json` 中 `devDependencies.electron`），CommonJS（`"type": "commonjs"`），Node 22（CI）
- 无前端框架、无打包器、无 TypeScript：渲染层就是原生 HTML + CSS + ES5 风格 IIFE 脚本
- 打包工具：Electron Forge 7（`forge.config.js`），makers：Squirrel（Windows）、zip（macOS）、deb/rpm（Linux）
- `.npmrc` 配置了 npmmirror 的 Electron 镜像（`electron_mirror`），安装依赖在国内网络下进行
- 打包时的 JS/HTML/CSS 压缩（terser / html-minifier-terser / clean-css）是 devDependencies，通过 `forge.config.js` 的 `packageAfterCopy` 钩子执行

## 目录结构与模块划分

```
index.js            主进程入口：创建 BrowserWindow（1080x720，contextIsolation: true，
                    nodeIntegration: false），app ready 后调用 main/ffmpeg.registerIpc()；
                    开发模式自动开 DevTools，打包后拦截 devtools-opened 强制关闭
main/ffmpeg.js      主进程核心：
                    - getFfmpegPath：Windows 用 bin/ffmpeg.exe（开发读项目根、打包读
                      resources/bin/，按 app.isPackaged 区分）；macOS 优先内置
                      bin/bin/ffmpeg，未内置时回退 Homebrew（/opt/homebrew/bin、
                      /usr/local/bin、PATH），找不到返回 null 由上层提示 brew install；
                      Linux 直接用系统 PATH 的 ffmpeg
                    - 能力探测：运行 ffmpeg -version/-hwaccels/-encoders/-formats，
                      解析输出并缓存到 userData/ffmpeg-caps.json（CACHE_VERSION = 4，
                      解析逻辑变更时需递增此版本号使旧缓存失效；同时校验 ffmpeg
                      版本字符串，变化也会重新探测）
                    - 硬件编码器实测：首次探测时对 *_nvenc/_qsv/_amf/_mf/_vaapi/_vulkan
                      等硬件编码器各试编码 1 帧（256x256，过小会触发最小分辨率限制
                      造成误判）到 null 设备，失败者在编码器条目上标 broken: true，
                      转码页下拉框会剔除；首页"清除硬件信息缓存"按钮可删除缓存重新探测
                    - 转码任务：spawn ffmpeg，参数含 -nostats -progress pipe:1，
                      解析 stdout 的 key=value 进度块，通过 'ffgui:convert-event'
                      推送 file-start / progress / file-done / file-error 事件
                      （spawn/日志/进度解析封装在 runFfmpegTask，转码、合并、截取、
                      预览共用）；质量档仅对 CRF_ENCODERS 传 -crf；VideoToolbox
                      编码器不支持 -crf，在 darwin+arm64 下改传 -q:v（VT_QSCALE_MAP，
                      仅 h264/hevc_videotoolbox，ProRes 画质由 profile 决定故排除），
                      Intel Mac 传 -q:v 会报错故留空走编码器默认值；nvenc/qsv/amf
                      码率留空时按质量档传恒定画质参数（HW_QUALITY_ARGS：nvenc 用
                      -rc vbr -cq、qsv 用 -global_quality、amf 用 -rc qvbr
                      -qvbr_quality_level，数值复用 CRF_MAP，越小质量越高；
                      amf 参数未在真机验证过）
                    - 合并任务：probeFile 用 ffmpeg -i 的 stderr 探测流信息（时长/
                      有无音视频流/分辨率，attached pic 封面不算视频流）；混合队列用
                      concat filter 重编码拼接，纯音频段生成等长黑屏（color 源）、
                      无音轨视频段生成静音（anullsrc）；纯音频队列 concat v=0 只拼音频；
                      输出文件名为 merged_<时间戳>.<格式>（buildMergeOutputPath）
                    - 截取任务（runClip）：无损切，-ss 放 -i 前快速 seek + -c copy
                      流复制 + -avoid_negative_ts make_zero，不重编码；起点落在
                      <= 起点的最近关键帧，可能有偏差（截取页已提示）；输出与源文件
                      同目录同扩展名（复用 buildOutputPath 的 _ffgui 后缀规则）
                    - 预览副本（runPreview）：截取页中浏览器无法解码的格式（wmv/flv 或
                      封装非常规编码的 mkv/avi；普通 mkv Chromium 可直接播放）自动转一份
                      低码率副本（视频 960p/ultrafast/crf30 + aac 96k；纯音频 aac 128k）
                      到 userData/preview-cache/（单槽位，生成前删旧），副本与原片
                      时间轴 1:1 对齐，截取与抓帧始终作用于原文件
                    - 抓帧截图（ffgui:captureFrame）：弹保存对话框后
                      ffmpeg -ss <t> -i <原文件> -frames:v 1 输出 PNG（原分辨率）
                    - IPC handler：ffgui:getCapabilities / clearCapsCache /
                      pickMediaFiles / pickDirectory / convert / cancelConvert /
                      probeMedia / merge / clip / makePreview / captureFrame
                      （合并、截取、预览的进度与取消均复用 convert 的事件与 IPC）
preload/preload.js  通过 contextBridge 暴露 window.ffgui（platform、versions、
                    getCapabilities、clearCapsCache、pickMediaFiles、pickDirectory、
                    getPathForFile、convert、cancelConvert、onConvertEvent、
                    probeMedia、merge、clip、makePreview、captureFrame、pathToFileUrl）
html/index.html     首页（功能导航卡片 + "清除硬件信息缓存"按钮）
html/convert.html   转码页
html/merge.html     合并页（队列拖动排序、混合队列黑屏段拼接）
html/clip.html      截取页（CSP 额外放行 media-src blob: file: 以播放本地文件）
html/js/index.js    首页视图切换与清缓存逻辑
html/js/convert.js  转码页全部逻辑：候选格式/编码器清单是硬编码的，但会按主进程
                    探测到的真实能力过滤后填充下拉框
html/js/merge.js    合并页全部逻辑
html/js/clip.js     截取页全部逻辑：原生 <video> 播放（不引第三方播放器库，库不增加
                    解码能力），起止双滑块 + 步进寻址 + 抓帧截图；播放 error 时调
                    makePreview 生成预览副本兜底，失败则判定无法预览、禁止截取
html/css/style.css  全部页面共用样式
bin/ffmpeg.exe      内置的 ffmpeg（Windows），约 110MB；放置规则见 bin/README.md：
bin/bin/ bin/lib/   macOS 为 bin/bin/ffmpeg + bin/lib/（自建预编译构建，来自
                    kisaragychihaya/ffmpeg_build_mac 的 release，混合静态构建：
                    大部分库静态编入，无 .a 静态库的依赖仍动态链接，经 dylibbundler
                    收集到 lib/，二进制引用 @executable_path/../lib，bin/ 与 lib/
                    相对布局不能变，只拷 ffmpeg 单文件无法运行）；打包时经
                    extraResource 复制到 resources/bin/；mac 未内置时回退 Homebrew
                    （官方源 ffmpeg 无 zimg，HDR 转 SDR 的 zscale 滤镜需要带 zimg
                    的构建，自建构建已含）；Linux 不携带 bin/，走系统 PATH
test_media/         手工测试用的示例音视频文件（不进入安装包）
_cdp_debug.js       开发调试脚本（CDP 连 Electron 渲染进程观察 video 加载状态，
                    依赖 ws，属一次性调试工具，不参与正常运行）
forge.config.js     Electron Forge 配置（含压缩钩子与 Fuses）
.github/workflows/  CI（见下文「部署 / CI」）
```

## 构建与运行命令

- `npm install` / `npm ci` — 安装依赖
- `npm start` — 开发运行（`electron-forge start`）
- `npm run package` — 打包到 `out/FFGui-win32-x64/`（packageAfterCopy 钩子会压缩 JS/HTML/CSS）
- `npm run make` — 生成安装包（Windows 为 Squirrel）

没有测试框架、没有 lint/format 配置。

## 部署 / CI

`.github/workflows/build.yml`（workflow_dispatch 手动触发或发布 Release 时触发）：

- Windows 任务：从 GyanD/codexffmpeg 的 GitHub 最新 release 下载 full_build.7z（gyan.dev
  直链在 CI 上会被反爬拦截），取 `ffmpeg.exe` 放入 `bin/`，`npm ci` + `npm run package`，
  产物压缩为 `FFGui-windows-x64.7z` 上传 artifact；Release 触发时同时上传到 Release Assets
- macOS 任务：下载 kisaragychihaya/ffmpeg_build_mac 最新 release 的 macos-arm64-static
  tar.gz，`bin/` 与 `lib/` 原样放入项目 `bin/` 并 `chmod +x`，打包后用 ditto 压缩为
  `FFGui-macos-arm64.zip`；Release 触发时同样上传
- 仓库本身不提交 `bin/ffmpeg.exe` 等大文件，CI 每次现下

## 代码约定

- 全部注释与界面文案使用简体中文，提交/文档同样使用中文
- 主进程/preload 为 CommonJS `require`；渲染进程脚本是无模块的 IIFE（HTML 有 CSP：
  `default-src 'self'; style-src 'self'; script-src 'self'`，禁止内联脚本与远程资源；
  clip.html 额外放行 `media-src 'self' blob: file:`）
- 渲染进程不得直接访问 Node API，一切跨进程能力走 `window.ffgui`（preload contextBridge）
- ffmpeg 的日志走 stderr、进度走 stdout（`-progress pipe:1`），主进程按行解析；
  新增转码功能时应复用 `main/ffmpeg.js` 中 `runFfmpegTask` 的 spawn/解析模式
- 输出文件名规则：与源文件同目录同格式时自动加 `_ffgui` 后缀避免覆盖源文件
  （`main/ffmpeg.js` 的 `buildOutputPath`）；合并输出固定为 `merged_<时间戳>.<格式>`

## 安全注意事项

- 保持 `contextIsolation: true`、`nodeIntegration: false`；新增 IPC 时只在 preload 中暴露最小 API
- forge.config.js 中启用了 Electron Fuses（RunAsNode: false、OnlyLoadAppFromAsar: true、
  EnableEmbeddedAsarIntegrityValidation: true 等），不要为图方便关闭
- HTML 中的 CSP meta 不要放宽
- 打包后禁止打开 DevTools（index.js 中拦截 devtools-opened）

## 已知问题

- 未配置应用图标（`packagerConfig.icon`），打包产物使用 Electron 默认图标；如需自定义，
  准备 `assets/imgs/favicon.ico`（或 .png/.icns）后在 `forge.config.js` 中配置
- 打包体积较大：`bin/ffmpeg.exe` 约 110MB，经 `extraResource` 原样分发且不进 asar，
  `packagerConfig.ignore` 中的 `/^\/bin($|\/)/` 规则不要删除，否则 asar 里会再塞一份；
  `extraResource` 按构建平台条件配置，Windows / macOS 携带 `bin/`，Linux 不携带
- forge.config.js 中不能出现 null 值（proxify 会崩溃），macOS 不签名靠省略 osxSign 实现
- `package.json` 中 `allowScripts` 字段是非 npm 标准字段（模板残留），当前无实际作用

## 测试方式

无自动化测试。手工验证方式：`npm start` 启动应用，使用 `test_media/` 下的示例文件走一遍
转码流程（含拖拽添加、取消、进度显示），并在主进程控制台观察 `[ffgui]` / `[ffmpeg]` 日志。
