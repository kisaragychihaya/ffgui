# 架构与目录结构

面向 AI 编码代理的补充文档（由 AGENTS.md 索引）。改动涉及目录内文件职责、IPC、协议时同步更新本文。

## 目录结构

```
index.js            主进程入口：BrowserWindow 1080x720（contextIsolation: true、
                    nodeIntegration: false），ready 后依次调用 main/ffmpeg.registerIpc()、
                    main/disc.registerDiscIpc()、main/theme（initTheme + registerThemeIpc）；
                    开发模式自动开 DevTools，打包后拦截 devtools-opened 强制关闭
main/ffmpeg.js      主进程核心，见下节
main/disc.js        光盘抓取编排（Rust 侧车 + 内部 FFmpeg 转码）。注册 ffgui:disc-pick-source /
                    disc-pick-keydb / disc-list-drives / disc-probe / disc-start / disc-cancel，
                    事件通道 ffgui:disc-event；同时只允许一个 disc 任务。侧车（native/ffgui-disc）
                    经 main/disc-sidecar.js 的 NDJSON 协议通信（stdin/stdout 一行一个 JSON，
                    stdout 只发事件），每次只处理一个标题；选轨三态 null=全部、[]=不保留、
                    非空=指定轨。无损 MKV 模式侧车直接写最终输出；转码模式先写任务唯一临时 MKV，
                    再经 runSingleFileConversion（main/ffmpeg.js 内部接口，preserveChapters 保留
                    章节）转最终文件，临时文件在所有终态清理。输出路径预分配防覆盖（含
                    .ffgui-partial 避让）；取消经 sidecar.cancel / cancelCurrentTask 分阶段处理；
                    MP4 模式强制 AAC 且每个标题必须显式选择不保留字幕（防静默丢轨）
main/disc-sidecar.js NDJSON 客户端：spawn 侧车、stdout 分帧/粘包、终态（result/error）判定、
                    cancel 宽限 + 强制 kill、stderr 有界诊断
main/cdrip.js      CD 抓轨（音乐 CD → FLAC 无损）。注册 ffgui:cd-list-drives / cd-probe /
                    cd-lookup / cd-release-tracks / cd-start / cd-cancel，事件通道
                    ffgui:cd-event；同时只允许一个 cd 任务。读盘走 FFmpeg 的 libcdio 输入
                    设备（不经 Rust 侧车），libcdio 用 avpriv_new_chapter 把每轨建成一个
                    章节，故 TOC 由解析 `-i <device>` 的 stderr 得到（-frames:a 0 只读头部，
                    不抓音频）。设备名按平台归一：Windows 盘符 "E:"（libcdio 只认两位形态，
                    "\\.\CdRom0" 打不开）、macOS "/dev/rdiskN"、Linux "/dev/srN"。
                    cd-list-drives 复用光盘侧车枚举（每条目只产 kind/path/label，无
                    displayName/vendor/model），用 entry.path 归一；侧车在 Linux 枚举到的是
                    sg 字符设备（libcdio 打不开），按同号启发式映射 /dev/sgN → /dev/srN
                    （未真机验证）。逐轨抓取为
                    `-ss <起> -i <device> -t <时长> -c:a flac`（-ss 前置走 read_seek 快速定位，
                    避免从头读整盘），写 .ffgui-partial 成功后改名；取消时 kill 子进程并清理。
                    只传 -n 不传 -y（两者互斥会让 ffmpeg 直接失败）。CD 参数锁定
                    s16/44100/立体声；压缩级别 0–12 白名单；cdparanoia 纠错五档
                    （disable/verify/overlap/neverskip/full）。MusicBrainz DiscID 按 libdiscid
                    算法自算（槽位 0 = lead-out、其后各轨起始帧、固定 100 槽位，base64 字母表
                    A-Za-z0-9._），与官方测试向量逐位一致；查询用 /ws/2/discid/?toc=...，
                    逐曲信息用 /ws/2/release/<id>?inc=recordings+artist-credits。元数据经
                    -metadata 传 Vorbis comment，专辑级字段 + 每轨覆盖（逐轨优先）。
                    三平台都要求内置 ffmpeg 带 --enable-libcdio（macOS 自建构建需显式开启）
main/dub.js         字幕配音（dub）：spawn 本地 TTS 引擎 tts-server（bin/tts/，打包后在
                    resources/tts/；环境变量 FFGUI_TTS_SERVER 可覆盖引擎路径供开发调试），
                    起 127.0.0.1 上的 OpenAI 兼容 HTTP 服务并按字幕条目逐条合成语音，再由
                    ffmpeg 按字幕原始时间轴拼装音频、与源视频混流输出。模型 GGUF 不随包
                    分发：首次使用下载到 userData/tts-models/（官方地址与 hf-mirror 镜像可
                    切）。下载器 resolveAria2 按四级优先：options.aria2 注入 → 环境变量
                    FFGUI_ARIA2（会跑 --version 自检）→ 内置 bin/aria2/aria2c.exe（打包后
                    resources/aria2/，仅 Windows x64，命中即信任不探测）→ PATH 上的 aria2c；
                    全都没有才回退内置 https 实现（该路径失败即删半成品）。aria2 路径用
                    -c 断点续传，取消/失败保留 .ffgui-partial 与 .aria2 控制文件；
                    一次下载内不切换实现；引擎缺失或
                    启动失败要给可读提示，不能静默产出无人声的结果；取消需 kill 引擎子进程并
                    清理临时音频与半成品
main/theme.js       主题持久化（system/light/dark）到 userData/config.json 的 theme 字段，经
                    nativeTheme.themeSource 强制全局生效；IPC ffgui:theme-get / ffgui:theme-set
                    （校验合法性 → 持久化 → 改 themeSource → 广播 ffgui:theme-changed）
                    config.json 与 main/i18n.js 共用：两边都按「读 → 合并 → 写」处理，不覆盖对方字段
main/i18n.js        界面多语言：加载 locales/<lng>.json 词典，t() 支持点路径与 {{var}} 插值（缺词
                    回退 zh-CN，再回退键名）；detectSystemLang 把 app.getLocale() 映射成
                    zh-CN / zh-TW / en / ja / ko；语言设置持久化到 config.json 的 language 字段
                    （system = 跟随系统）；IPC ffgui:i18n-sync（sendSync，预加载脚本同步取词典）与
                    ffgui:language-set（校验 → 持久化 → 广播 ffgui:language-changed，含新词典）
preload/preload.js  contextBridge 暴露 window.ffgui：platform、versions、getCapabilities、
                    clearCapsCache、pickMediaFiles、pickDirectory、getPathForFile、convert、
                    cancelConvert、onConvertEvent、probeMedia、merge、pickSubtitle、
                    probeSubtitle、clip、makePreview、captureFrame、recordPickOutput、
                    recordStart、recordWriteChunk、recordFinish、recordDiscard、recordRemux、
                    getDesktopSources、prepareDesktopSource、pathToFileUrl、getTheme、setTheme、
                    onThemeChanged、i18n（同步取回的词典快照）、setLanguage、onLanguageChanged、
                    discPickSource、discPickKeydb、discListDrives、discProbe、
                    discStart、discCancel、onDiscEvent、cdListDrives、cdProbe、cdLookup、
                    cdReleaseTracks、cdStart、cdCancel、onCdEvent。除主题、语言与光盘 /
                    CD 抓轨外与主进程 IPC 同名；新增 IPC 只在此暴露最小 API
html/*.html         index（首页导航卡片 + 清除硬件信息缓存按钮）、convert、merge、clip、crop、
                    record、disc（统一光盘页，手动选「视频光盘 / 音乐 CD」动态切换）、dub。
                    CSP 统一为 default-src 'self'; style-src 'self';
                    script-src 'self'；clip/crop/record 额外放行 media-src 'self' blob: file:，
                    record 另放行 img-src 'self' data:（来源缩略图）
html/js/index.js    首页视图切换与清缓存
html/js/i18n.js     所有页面最先加载（须先于 theme.js 与各页面脚本）：从 window.ffgui.i18n
                    （preload 同步取回的词典快照）建 t()/applyStatic()，刷新 <html lang>、
                    document.title（取自 <html data-i18n-title>）、[data-i18n] 文本与
                    [data-i18n-attr]（placeholder/title 等属性）；语言切换经
                    ffgui:language-changed 广播换词典并回调 onChange；向每页右上角注入语言下拉
                    （跟随系统 + 五种语言，样式见 style.css 的 .lang-toggle/.lang-popup）
html/js/theme.js    在 i18n.js 之后、各页面脚本之前加载：监听 matchMedia('(prefers-color-scheme:
                    dark)') 在 <html> 上设 data-theme=light/dark（themeSource 变化与系统切换都会
                    触发 change）；向每页右上角注入主题切换按钮（跟随系统 → 浅色 → 深色循环，
                    图标按 data-mode 显隐，经 ffgui:getTheme/setTheme 同步；提示文案走词典
                    theme.tipSystem/tipLight/tipDark）
locales/<lng>.json  五个语言的界面词典（zh-CN / zh-TW / en / ja / ko，zh-CN 为回退与源文案）。
                    嵌套 JSON，键用点路径，命名空间与页面同名：common、theme、lang、home、
                    convert、merge、clip、crop、record、disc、cd、dub、main（主进程报错/
                    对话框标题）。主进程与渲染层共用同一份文件；五语言键集合必须一致
                    （scripts/i18n.test.cjs 校验）
html/js/convert.js  转码页：候选格式/编码器清单硬编码，按主进程探测结果过滤后填下拉框；设备预设
                    按 DEVICE_PRESETS 表锁定并填兼容参数（切回自定义时恢复原设置，提示文案与
                    帧率标签随预设变化），纯音频格式自动隐藏视频表单项；提交前校验分辨率与帧率
                    （帧率可手填 1–240 的数字，留空保持源帧率）
html/js/merge.js    合并页：字幕单槽位拖放（拖到拼接队列区域会自动转投字幕槽位）；开始前校验
                    字幕时长与合并总时长，相差超过 10 秒才弹警告由用户确认（±10 秒内视为匹配）
html/js/clip.js     截取页：原生 <video> 播放（不引第三方播放器库，库不增加解码能力），起止双
                    滑块 + 步进寻址 + 抓帧；播放 error 时调 makePreview 生成预览副本兜底，
                    失败则判定无法预览、禁止截取
html/js/crop.js     裁剪页：只接受 probeMedia 判定 hasVideo 的单文件；暂停后点「绘制裁剪框」，
                    用 Pointer Events 在视频实际显示帧上拖拽画框（任意方向、边界钳制、框外压暗、
                    过小判无效）；canvas 按 object-fit: contain 的真实帧矩形定位（黑边不计入
                    坐标），随 devicePixelRatio 与 resize 重绘，选框按归一化坐标保存故不漂移；
                    界面只显示 X/Y/宽/高百分比（不做像素估算，probe 的 coded 尺寸在旋转/SAR 非 1
                    时会误导）；播放中禁止画框，切换文件或清除选框即重置并禁用开始；预览副本
                    只用于播放与画框，转换始终用原文件；提交 window.ffgui.convert 单输入 job
                    （MP4/libx264/aac/yuv420p + quality + crop，保留全部音轨，无设备预设/HDR/
                    scale/sampleOnly），进度与取消复用 onConvertEvent / cancelConvert
html/js/record.js   录屏页：desktopCapturer 缩略图弹窗选来源 → prepareDesktopSource 登记 →
                    getDisplayMedia 被授予该来源（系统声音为 'loopback' 回环音轨，仅 Windows）；
                    记住 sourceId，勾选系统声音后按原来源静默重新采集（失效才重开弹窗）；系统
                    声音与麦克风（getUserMedia）可选、双路混音走 AudioContext；MediaRecorder
                    输出 WebM（vp9 优先，画质档映射 videoBitsPerSecond 8/4/2 Mbps），1s 分块
                    串行写入主进程；录制中 beforeunload 拦截离开页面
html/js/disc.dvd.js 光盘页·视频光盘侧（disc 命名空间）：discListDrives 光驱下拉 /
                     discPickSource（ISO/目录）→ discProbe 列标题 → 选轨（音轨/字幕三态）→
                     discStart（无损 MKV 经 Rust 侧车直写 / 转码模式先写临时 MKV 再转最终），
                     进度经 onDiscEvent
html/js/disc.cd.js   光盘页·音乐 CD 侧（cd 命名空间）：cdListDrives 光驱下拉 → cdProbe 读 TOC
                     （不抓音频）→ 可选 cdLookup / cdReleaseTracks 从 MusicBrainz 填标签（联网
                     失败不阻塞，仅记日志并保留手动填写）→ 勾选曲目并逐首编辑曲名/演唱者 →
                     cdStart 逐轨抓 FLAC。进度经 onCdEvent（progress 按本轨 -t 时长换算百分比）。
                     盘上不可信字符串（DiscID、曲名、专辑名）一律 textContent 写入，绝不拼
                     HTML；渲染层只传设备名与轨号，FFmpeg 命令行由主进程拼装。纠错/压缩档位
                     与主进程白名单一一对应（scripts/cd-ui.test.cjs 校验）
html/js/disc.type.js 光盘页类型切换控制器（disc.type* 文案）：两张 .type-option 卡片手动选
                     「视频光盘 / 音乐 CD」，按纯逻辑函数 typePanels() 显隐两侧外壳面板
                     （video → source/titles/output/action；cd → cd-source/tracks/meta/
                     cd-output/cd-action）；任一侧任务 running 时禁止切换（canSwitchType，
                     防两侧并发读写同一光驱）；跨 IIFE 通信只经 window.__ffguiDiscPage /
                     window.__ffguiCdPage 两个最小钩子（isRunning / refreshDrives）；光驱枚举
                     改为选类型时惰性触发（两侧 IIFE 不再加载即枚举）
html/js/dub.js      字幕配音页：载入字幕 → 逐条合成/试听 → 生成配音音轨并与视频混流；文案走
                    locales 的 dub 命名空间，能力全部经 window.ffgui（不碰 Node 与文件系统）
html/css/style.css  全部页面共用样式
bin/                内置 ffmpeg。Windows 只带 ffmpeg.exe 单文件（约 140–210MB，ffprobe 未被
                    使用故不带），打包后到 resources/ 根目录（getFfmpegPath 优先
                    resources/ffmpeg.exe，兼容旧布局 resources/bin/ffmpeg.exe）；macOS 为
                    bin/bin/ffmpeg + bin/lib/（相对布局不能变，只拷 ffmpeg 单文件无法运行；官方
                    brew 构建无 zimg 而 HDR 转 SDR 需要，故未内置时才回退 Homebrew），打包后到
                    resources/bin/；Linux 不携带，走系统 PATH。bin/disc/ 放 Rust 侧车二进制
                    （ffgui-disc.exe / ffgui-disc），经 extraResource 分发且不进 asar，打包后在
                    resources/disc/。bin/tts/ 放 TTS 引擎 tts-server 及其同目录 ggml 动态库
                    （由 native/qwentts.cpp 子模块编译，Windows 带 Vulkan 后端、macOS 纯
                    CPU），同样经 extraResource 到 resources/tts/；Linux 不携带（回退 PATH）。
                    packagerConfig.ignore 中的 `/^\/bin($|\/)/` 规则不要删除，否则 asar 里会
                    再塞一份
forge.config.js     压缩钩子、Fuses（RunAsNode: false、OnlyLoadAppFromAsar: true、
                    EnableEmbeddedAsarIntegrityValidation: true 等，不要关闭）、按构建平台条件
                    配置的 extraResource（bin/tts/ 目录不存在时跳过，未初始化子模块也能打包）；
                    不能出现 null 值（proxify 会崩溃）
native/ffgui-disc/  Rust 光盘侧车（cargo crate，freemkv-engine v1.8.4，[patch.crates-io] 固定
                    上游 git tag）：ISO / 已解密目录 probe + 单标题无损 MKV rip；物理光驱代码
                    已接入但未真机验证，keydbPath 可选本地密钥库（在线密钥服务禁用）。产物
                    target/release/ffgui-disc(.exe)，打包时复制到 bin/disc/。freemkv-unlock 内含
                    非 MIT 厂商驱动微码，分发须随附上游 LICENSES/NOTICE
native/qwentts.cpp/ git submodule：TTS 引擎 tts-server 源码（fork 自 ServeurpersoCom/qwentts.cpp，
                    内部还套着 ggml 子模块，clone 必须 --recurse-submodules，CI 的 checkout
                    用 submodules: recursive）。cmake 构建，Vulkan 后端开关是 ggml 的
                    -DGGML_VULKAN=ON（Vulkan SDK 必需，ggml-vulkan 要求 glslc 与
                    SPIRV-Headers）；产物 CMAKE_RUNTIME_OUTPUT_DIRECTORY = 构建根目录，即
                    build/tts-server(.exe)（VS 生成器在 build/Release/），同目录还会生成
                    ggml*.dll（ggml 默认动态库构建，必须与 exe 一起拷到 bin/tts/）。
                    tts-server 对外是 OpenAI 兼容 HTTP 服务（--model / --codec / --host /
                    --port / --alias / --device，另有 MODEL_PATH、CODEC_PATH 环境变量）
makers/nsis.js      本地 NSIS maker 适配层，实际编译在 scripts/build-installer.cjs；必须 new
                    实例传入（Forge 凭 __isElectronForgeMaker 识别）
assets/installer.nsi NSIS 脚本：MUI2 现代界面（欢迎/许可证[须同意]/目录/安装/完成页），LZMA
                    固实压缩 + 64MB 字典，每用户安装（%LOCALAPPDATA%\Programs，无需管理员），
                    桌面与开始菜单快捷方式「狒狒格式工具箱」+ 卸载入口，写 HKCU 卸载注册表项；
                    安装与卸载均先 taskkill 结束运行中的 FFGui 进程（nsExec 静默），卸载对杀软
                    临时占用重试一次；中文产品名/路径由构建时生成的 UTF-8 BOM defines.nsh 注入
                    **多语言**：MUI_LANGUAGE 依次 English / SimpChinese / TradChinese / Japanese /
                    Korean，NSIS 按系统显示语言（$LANGUAGE 启动值）自动选，系统语言不在列表时
                    用第一个 ⇒ English 放最前即「兜底英文」；自定义文案（主程序/运行/品牌行/
                    卸载快捷方式名）全部用 LangString，新增语言要补全这 4 组；产品名 ${APP_NAME}
                    是品牌名，各语言保持一致（安装目录与快捷方式路径因此不随语言变化）；
                    想加手动语言选择框就插 !insertmacro MUI_LANGDLL_DISPLAY（当前不插 = 全自动）。
                    **卸载段的段名必须字面量写 "Uninstall"**，不能改成 LangString/别的名字：
                    NSIS 仅凭段名把该节归给卸载器，改名后它会作为普通安装段在装完后立刻执行
                    （删除文件/快捷方式/卸载注册表项），且安装程序仍返回退出码 0 ⇒ 表现为
                    「装完没有快捷方式、程序目录只剩 FFGui.exe」（v0.6.1 曾因此翻车）
scripts/build-installer.cjs  编译安装包：调用 tools/nsisbi/makensis.exe；也可独立运行
                    node scripts/build-installer.cjs --app-dir out/FFGui-win32-x64 [--arch arm64]
                    （CI 即此用法）；先复制 installer.nsi 并补 UTF-8 BOM（makensis 把无 BOM
                    文件按 ANSI 解析）；defines.nsh 只注入产品名/版本/路径/版本信息（界面文案
                    已移到 installer.nsi 的 LangString）
scripts/build-tts.cjs  编译 TTS 引擎并拷到 bin/tts/：node scripts/build-tts.cjs [--backend
                    vulkan|cpu] [--arch x64|arm64] [--no-native] [--clean]。默认后端按平台
                    选（Windows x64 = Vulkan，macOS / Windows arm64 / Linux = CPU），内部
                    调用 cmake（-DGGML_VULKAN=ON|OFF，Windows arm64 另加 -A ARM64），无
                    cmake 时给中文安装提示。CI 三个平台都用它；分发构建必须带 --no-native
                    （宿主 CPU 优化会让产物在用户机器上报非法指令）
tools/nsisbi/       NSISBI（解除 2GB 限制分支）免安装 amd64 版解压目标目录（v3.12.2）。二进制
                    不入库：构建时从 v0.1 Release 资源下载解压（curl.exe + System32 绝对路径的
                    bsdtar，PATH 里 Git 的 GNU tar 不认 zip）；目录内容被 .gitignore 忽略，
                    删后下次构建自动重下
test_media/         手工测试用的示例音视频文件（不进入安装包）
_cdp_debug.js       开发调试脚本（CDP 连渲染进程观察 video 加载状态，依赖 ws 未列入
                    package.json，需另行 npm i ws），一次性工具，不参与正常运行
.github/workflows/  CI，见 docs/build-release.md「部署 / CI」
```

## main/ffmpeg.js 要点

- **getFfmpegPath**：Windows 开发读项目根 `bin/ffmpeg.exe`、打包读 resources（按
  `app.isPackaged` 区分）；macOS 优先内置 `bin/bin/ffmpeg`，未内置时回退 Homebrew
  （/opt/homebrew/bin、/usr/local/bin、PATH），找不到返回 null 由上层提示 brew install；
  Linux 直接用系统 PATH
- **能力探测**：运行 `ffmpeg -version / -hwaccels / -encoders / -formats`，缓存到
  `userData/ffmpeg-caps.json`（`CACHE_VERSION = 4`，解析逻辑变更须递增使旧缓存失效；ffmpeg
  版本字符串变化也会重新探测）。硬件编码器实测：对 `*_nvenc / _qsv / _amf / _mf / _vaapi /
  _vulkan` 等各试编码 1 帧（256x256，过小会触发最小分辨率限制造成误判）到 null 设备，失败者
  标 `broken: true`，转码页下拉框剔除；首页按钮可删缓存重探
- **runFfmpegTask**：spawn ffmpeg，参数含 `-nostats -progress pipe:1`，解析 stdout 的
  key=value 进度块，经 `'ffgui:convert-event'` 推送 file-start / progress / file-done /
  file-warning / file-error；转码、合并、截取、预览、录屏转 MP4 共用。取消经
  `ffgui:cancelConvert` → `cancelCurrentTask` 置位并 kill 子进程，close 回调里删除本次新产生
  的半成品 output（任务启动前已存在的文件不删）
- **设备预设**（`job.devicePreset`）：主进程由 `normalizeConvertJob` 按 `DEVICE_PRESETS` 表
  二次落实（不能被旧表单值覆盖，须在分配输出扩展名前调用），每个预设锁定 格式/编码器/
  Profile/Level/位深/帧率上限/分辨率/VBV 码率三件套/音频码率/声道/采样率；渲染层 convert.js
  有同名表负责填表单与提示文案，键须一一对应：

  | 键 | 参数 |
  |---|---|
  | bili-1080p | High 4.2 / 60fps / 6000k 峰值 12000 / AAC 320k（B站免二压均值上限 6000） |
  | bili-720p | High 3.1 / 3000k / AAC 192k |
  | douyin-1080p | High 4.2 / 60fps / 6000k / AAC 192k |
  | wechat-1080p | High 4.0 / 4000k / AAC 128k |
  | youtube-1080p | High 4.2 / 60fps / 8000k 峰值 12000 / AAC 384k |
  | ipod4-540 / ipod4-720 | Main 3.1 / 30fps / 2000k / AAC 128k |
  | iphone4s | High 4.0 / 1080p30 / 4000k / AAC 160k（Apple 官方 1080p 上限） |
  | psp | Main 2.2 / 480x272 / 1000k |
  | android-legacy | Baseline 2.1 / 800x480 / 1000k / 44.1kHz |
  | web-safe | Baseline 3.0 / 720p / 2500k |
  | tv-4k | High 5.1 / 2160p30 / 20000k 峰值 40000 / AAC 192k（兼 B站 4K） |

  全部为 MP4/libx264/yuv420p/保持比例/AAC-LC 双声道 + VBV + faststart，默认第 1 音轨；
  H.264 Level 白名单含 2.1–5.2。预设用到 `-fpsmax` 与 scale 的 `reset_sar`，需要较新
  FFmpeg（5.1+/6.1+）
- **码率/画质**：质量档仅对 `CRF_ENCODERS` 传 `-crf`；VideoToolbox 不支持 `-crf`，darwin+arm64
  下改传 `-q:v`（`VT_QSCALE_MAP`，仅 h264/hevc_videotoolbox，ProRes 画质由 profile 决定故
  排除），Intel Mac 传 `-q:v` 会报错故留空走编码器默认值；nvenc/qsv/amf 码率留空时按质量档
  传恒定画质参数（`HW_QUALITY_ARGS`：nvenc `-rc vbr -cq`、qsv `-global_quality`、amf
  `-rc qvbr -qvbr_quality_level`，数值复用 `CRF_MAP`，越小质量越高；amf 参数未真机验证）
- **自定义高级参数**（像素格式、Profile/Level、声道、采样率、ID3 版本、标签/封面开关、30 秒
  试转）由 `validateConvertOptions` 白名单校验；固定帧率开放手填数字（UI 为 input+datalist），
  主进程按 1–240 校验（23.976/29.97/59.94 仍映射 24000/1001 等分数）；复制流与转码参数冲突
  直接报错
- **纯音频封面**：MP3/M4A/FLAC 默认保留内嵌封面——`probeFile` 返回 `covers[]`（attached pic
  的流编号与编码），只显式映射封面流，JPEG/PNG 原样复制、其他转 mjpeg，多张封面保留类型；
  WAV/OGG/OPUS 不保留封面，仅发 file-warning；`-map_metadata 0` 保留文字标签（可关），MP3
  显式 `-id3v2_version`（默认 3）
- **可视化裁剪**（`job.crop`）：归一化矩形 `{x, y, w, h}`，相对视频实际画面（0~1，与像素无关，
  预览副本上选的数值同样适用），x/y 为左上角、w/h 为宽高；边界容差只吸收浮点误差
  （`CROP_EPS = 1e-6`）。由 `validateConvertOptions` 校验（非法抛中文错误；与 `vcodec: 'copy'`
  同存直接拒绝），`buildCropFilter` 生成 crop 滤镜：按 in_w/in_h 等比例换算、宽高向下取偶兼容
  yuv420p；极小合法区域加固为宽高至少 2，x/y 必要时按 out_w/out_h 钳制，避免边缘越界（如
  x+w 超出 1 的浮点误差）。滤镜链顺序固定 Crop → HDR → Scale：crop 必须位于链首（基于滤镜实际
  输入尺寸），HDR→SDR 色调映射（zscale 线性光 → tonemap=hable → bt709）作用于裁剪后的画面，
  scale 追加在链尾
- **合并任务**：`probeFile` 用 `ffmpeg -i` 的 stderr 探测流信息（时长/有无音视频流/分辨率，
  attached pic 封面不算视频流）；混合队列用 concat filter 重编码拼接，纯音频段生成等长黑屏
  （color 源）、无音轨视频段生成静音（anullsrc）；纯音频队列 concat v=0 只拼音频；输出
  `merged_<时间戳>.<格式>`（`buildMergeOutputPath`）；可选字幕（`job.subtitle = { path, mode }`）：
  burn 硬字幕在 concat 后经 subtitles 滤镜烧录（转义见 `escapeSubtitleFilterPath`：正斜杠 +
  `\:` + 单引号包裹），embed 软字幕作为额外输入 `-map` 进容器（MKV `-c:s copy`、MP4 转
  mov_text，lavfi 输入索引相应后移 lavfiBase）；字幕时长探测 `probeSubtitleDuration` 直接解析
  文本时间戳（ffmpeg -i 对字幕输出 `Duration: N/A`），支持 srt/vtt/ass/ssa；有字幕时允许只给
  1 个音视频文件；纯音频队列拒绝字幕
- **截取任务**（`runClip`）：无损切，`-ss` 放 `-i` 前快速 seek + `-c copy` +
  `-avoid_negative_ts make_zero`，不重编码；起点落在 <= 起点的最近关键帧，可能有偏差（截取页
  已提示）；输出与源文件同目录同扩展名（复用 `buildOutputPath` 的 `_ffgui` 后缀规则）
- **预览副本**（`runPreview`）：截取页与裁剪页中浏览器无法解码的格式（wmv/flv 或封装非常规
  编码的 mkv/avi；普通 mkv Chromium 可直接播放）自动转低码率副本（视频 960p/ultrafast/crf30
  + aac 96k；纯音频 aac 128k）到 `userData/preview-cache/`（单槽位，生成前删旧），副本与原片
  时间轴 1:1 对齐；截取页的截取与抓帧、裁剪页的最终转换始终作用于原文件
- **抓帧截图**（`ffgui:captureFrame`）：弹保存对话框后 `ffmpeg -ss <t> -i <原文件> -frames:v 1`
  输出 PNG（原分辨率）
- **录屏采集授权**（`registerDisplayMediaHandler`，注册在 defaultSession）：Electron 的
  `useSystemPicker` 仅 macOS 15+ 有效，Windows/Linux 必须由 handler 授予 desktopCapturer 来源。
  渲染进程在来源弹窗选定后先经 `ffgui:prepareDesktopSource` 登记来源 id，紧接着调用
  getDisplayMedia，handler 按登记授予（video 为所选来源；audio 请求且 win32 时授予 'loopback'
  系统声音回环——Electron 文档明确仅 Windows 支持，macOS/Linux 无系统级回环，只能录麦克风；
  渲染层开始录制时校验「勾了系统声音但流里没有音轨」并拦截，勾选发生在选择来源之后会自动按
  已登记的 sourceId 静默重新采集，来源失效才重开弹窗）
- **录屏写盘**：MediaRecorder 按 1s 分块经 `ffgui:recordWriteChunk` 流式追加到主进程
  `fs.WriteStream`（recordStreams 按路径存流，write 等回调实现背压）；`recordStart` 在开始录制
  时显式建流（同路径在录则报错），`writeChunk` 绝不事后新建（'w' 会截断已完成的文件），停止后
  迟到的分块被拒绝；渲染层另有 starting/stopping/acceptChunks 防重入与分块接收窗口，杜绝并发/
  迟到写入截断文件；`recordPickOutput` 弹保存对话框（默认 视频/record_<时间戳>.webm）；
  `recordFinish` 关流返回大小；`recordDiscard` 删半成品；`recordRemux` 把 WebM 转 MP4
  （`-c:v copy` 无损 + Opus 转 AAC，无音轨传 `-an`，复用 runFfmpegTask 进度事件）；
  `getDesktopSources` 枚举屏幕/窗口来源（含缩略图 data URL）
- **IPC handler**：`ffgui:getCapabilities / clearCapsCache / pickMediaFiles / pickDirectory /
  convert / cancelConvert / probeMedia / merge / pickSubtitle / probeSubtitle / clip /
  makePreview / captureFrame / recordPickOutput / recordStart / recordWriteChunk /
  recordFinish / recordDiscard / recordRemux / getDesktopSources / prepareDesktopSource`
  （合并、截取、预览、录屏转 MP4 的进度与取消均复用 convert 的事件与 IPC）

## 音轨与输出规则（修复后）

- `job.audioTrack` 留空保留全部音轨，否则为从 1 开始的音轨序号。MP3/FLAC/WAV/FLV 多音轨输入
  须明确选轨。设备预设例外：留空取第 1 轨（映射 `0:a:0?`）
- `probeFile` 额外返回 `audioTracks`（按顺序排列的语言信息）。合并按序号逐轨 concat，缺轨补
  静音；每轨仍统一 44100 Hz stereo，界面明确提示规则
- 转码显式映射视频、音频；MKV 同时映射字幕附件，其他转码容器不隐式带入附加流。截取使用
  `-map 0 -c copy` 保留全部流
- 输出路径避开全部输入、已有文件与本批目标，重名增加编号；转码/合并/截取使用 `-n`，不要改回
  无条件 `-y`。预览缓存与用户在保存对话框中选定的截图仍可覆盖
- 进度字段跨 stdout 数据块保留，progress 事件携带 input；成功任务还必须收到 `progress=end`
  （部分 FFmpeg 构建拒绝覆盖也返回退出码 0）
- 字幕路径分两层转义：先滤镜选项值，再滤镜图；调用方不再额外加单引号
- 截取输入框保留毫秒，三个时间滑块步长 0.001 秒
