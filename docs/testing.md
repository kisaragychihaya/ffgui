# 测试与已知问题

面向 AI 编码代理的补充文档（由 AGENTS.md 索引）。新增测试文件、发现新的限制时同步更新本文。

## 测试方式

`npm test` 跑 `scripts/regression.test.cjs` + `scripts/i18n.test.cjs` + `scripts/cdrip.test.cjs`
+ `scripts/cd-ui.test.cjs`，生成独立临时媒体并自动清理；字幕配音（dub）的专项测试按同一命名
约定是 `scripts/dub.test.cjs`（主进程：引擎路径解析、ffmpeg 命令组装、字幕条目解析与时间轴
换算、模型下载的 https/aria2 两条路径与内置 aria2c 路径解析——aria2 用注入的假 spawn，
默认注入 `aria2: false` 避免真探测 PATH；请求体断言 voice = 所选说话人、seed 固定 0，
DEFAULT_SPEAKERS 十项与 normalizeSpeaker 的归一（大小写不敏感、非字符串/白名单外回默认
Vivian，服务层再验一次非法说话人不报错照常配音）；配音成功链路上还覆盖三条防静默产出的自检：空 data
段的 WAV 在第 N 条就报 FFGUI_DUB_SYNTH、组装音轨全静音报 FFGUI_DUB_SILENT（假 ffmpeg 按
`volumedetect` 参数分支回 -91.0 dB）、成品音轨数不对报 FFGUI_DUB_MUX 并删成品。mock 用
`producedOutputs` 记住本任务写出的文件来区分「源探测」与「混流后回探」，判别混流调用要看
2 个 -i 且无 -filter_complex——组装命令里也有 -map（[dubout]），不能拿 -map 判；混音分支
（mix = true）自带 -filter_complex，该判据不适用，按「args 最后一个元素 = 输出路径」定位）；
混音模式另有专项：argv 含 `[1:a]volume=<dB>dB` + `amix=inputs=2:duration=longest:normalize=0`
+ `-ac 2`、只有一次 `-c:a`、无 `-map 1:a:0` 与多轨 disposition、源无音轨时退化为单配音轨，
映射表按输出容器断言——MKV 为 `['0:v','[mixout]','0:s?','0:t?']` 且带 `-c:t copy`
（keepSubtitle=false 时附件仍带），MP4 明确不带 `0:t?` / `-c:t`（MP4 无附件概念，硬 map 会
让 muxer 报 codec not currently supported in container），
validateDubJob 的 mix（只认布尔 true）/ mixVolumeDb（越界钳制到 -30~+12、非数值回 0），服务层
再验混音成功（回探期望 1 条）与回探到 2 条时报 FFGUI_DUB_MUX；dub 页的纯逻辑 UI 测试文件
（`scripts/dub-ui.test.cjs`，仿 `cd-ui.test.cjs` 注入真实 `locales/zh-CN.json`）尚未建立，
新增后要一并加进 `package.json` 的 `npm test`；
侧车/页面专项用
`node --test scripts/disc.test.cjs scripts/disc-sidecar.test.cjs scripts/disc-ui.test.cjs`，
Rust 侧车 `cd native/ffgui-disc && cargo test --locked`。`disc-ui.test.cjs` 用 vm 抽取
`html/js/disc.dvd.js` 与 `html/js/disc.type.js` 的「纯逻辑」段求值，并注入真实
`locales/zh-CN.json` 作为 `window.i18n.t`，因此它同时校验用户看到的中文原文；
`cd-ui.test.cjs` 对 `html/js/disc.cd.js` 同样处理。
`regression.test.cjs`、`disc.test.cjs` 用 vm 加载主进程文件时，
`require` 桩需把 `'./i18n'` 映射到 `main/i18n.js`（否则沙箱里解析不到同目录模块）；
`cdrip.test.cjs` 还需把 `'./ffmpeg'` 映射到返回假路径的桩，并 mock
`child_process.spawn`（否则测试会去调真实 ffmpeg / 光驱）。
多语言改动后另需 `npm start` 逐页切换语言核对（含主进程报错与文件对话框标题）。手工验证：
`npm start` 后用 `test_media/` 示例文件走一遍转码（含拖拽、取消、进度），观察主进程 `[ffgui]` /
`[ffmpeg]` 日志；录屏页验证录制（含系统声音/麦克风勾选、取消清理半成品、转 MP4）；
统一光盘页（disc.html）验证类型切换、ISO/目录/光驱的探测、选轨、抓取与取消（视频盘需真实
光盘环境）；选「音乐 CD」后验证光驱枚举、读 TOC、MusicBrainz 查询与填充、逐轨抓 FLAC 与
取消（需真实音乐 CD）；
字幕配音页验证引擎启动（无引擎时报错是否可读）、模型下载与三源切换（官方 / hf-mirror /
ModelScope；选 ModelScope + Q4_K_M 时主进程会打 `[ffgui]` 日志并回退 hf-mirror，Q8_0 才真正
走 modelscope.cn。用随包内置的 aria2c：
Windows 是 `resources/aria2/aria2c.exe`，macOS 是 `resources/bin/aria2/aria2c`。下载中途取消、
重进页面再点下载应续传而不是从 0 开始；`FFGUI_ARIA2` 指向不存在的路径 + PATH 里也没有
aria2c 时，应自动回退内置 https 下载）、
逐条合成试听、混流输出与取消清理（需 `bin/tts/` 中有 tts-server 或设置 `FFGUI_TTS_SERVER`）、
「混音输出」勾选后成品只剩一条音轨（播放器里切不到原声）、配音音量能听出变化（-30 dB 几乎只剩
原声，+12 dB 配音明显压过原声）、未勾选时音量输入应禁用且提示行切回「原音轨保留」那段。

## 已知问题

- 图标为 `assets/imgs/` 下像素风胡萝卜（icon.png / icon.ico / icon.icns，命名必须与
  `packagerConfig.icon` 一致，electron-packager 才能按平台自动选扩展名），由
  `packagerConfig.icon`、index.js 窗口图标与各 HTML favicon 引用
- 体积较大：`bin/ffmpeg.exe`（约 140–210MB）经 extraResource 原样分发且不进 asar，
  `packagerConfig.ignore` 中的 `/^\/bin($|\/)/` 规则不要删除。已做精简：不带 ffprobe、
  packageAfterCopy 裁剪 Electron 语言包（仅 zh-CN/en-US，省约 45MB）、删除仅 WebGPU 使用的
  dxcompiler.dll/dxil.dll（省约 26MB）与运行时无引用的 LICENSES.chromium.html（省约 19MB），
  Rust 侧车启用 `profile.release` 的 strip/LTO/codegen-units=1（11.3MB → 9.5MB），
  arm64 载荷约 420MB、安装包约 119MB；如仍嫌大可把 CI 的 ffmpeg 换成 gyan.dev essentials
  构建（33MB，但会失去 libxvid/libkvazaar/libopenh264/prores_ks/ac3/eac3 等编码能力，需评估）
- `packagerConfig.ignore` 已排除全部构建期文件（`tools/`、`makers/`、`assets/installer.nsi`、
  `_cdp_debug.js`、`.github/`、`docs/`、各类 md）。其中 `/^\/tools($|\/)/` 尤其重要：
  `tools/nsisbi/` 是本机跑过 `npm run make` 后才出现的 NSISBI 编译器（377 个文件），漏排会
  整份打进 asar（实测 447 → 63 个条目）。新增构建脚本/工具目录时记得同步这里；CI 的 ffmpeg
  解压残留也曾漏排（`ffmpeg-<版本>-full_build/` 约 860MB 进 asar，安装包 149 → 493MB），现在
  workflow 解压到 `$RUNNER_TEMP` 且 ignore 兜底 `/^\/ffmpeg-.*/`，**新增 CI 解压步骤时
  不要往仓库根目录留大目录**
- `package.json` 中 `allowScripts` 是非 npm 标准字段（模板残留），当前无实际作用
- 多语言：ja / ko 译文由本仓库维护，专业术语（编码器 / 容器 / 预设名）已统一，但措辞未经母语
  审校；新增文案须同时补齐五种语言（`scripts/i18n.test.cjs` 会拦键集合与占位符不一致）。
  主进程已发出的日志行不会因切换语言回溯翻译（只影响之后新产生的消息）
- 录屏限制：系统声音走 'loopback' 回环仅 Windows 支持（macOS/Linux 无系统级回环，只能录麦克风）；
  MediaRecorder 画质只能控码率（无 CRF），帧率跟随屏幕；录屏与转码等任务沿用全局单任务假设
  （页面隔离保证不并发）
- 光盘抓取限制：物理光驱代码已接入（open_scan/DiscSession）但未真机验证，本机无光驱；AACS
  keydb 需用户自备本地 KEYDB.cfg，在线密钥服务禁用；BD+ 盘未验证；`bin/disc/ffgui-disc.exe`
  （约 9.5MB，已启用 strip/LTO）随 extraResource 分发，三个 CI 平台均先构建对应架构侧车再打包
- CD 抓轨限制：**必须内置带 `--enable-libcdio` 的 ffmpeg**，否则光驱枚举后仍读不出 TOC
  （Windows 的 gyan full_build 已带；macOS 自建构建需在 configure 里显式加
  `--enable-libcdio`；Linux 取决于系统 ffmpeg）。未真机验证（本机无光驱），仅
  `scripts/cdrip.test.cjs` 以 mock spawn 覆盖了 TOC 解析、DiscID、参数组装与取消清理。
  MusicBrainz 查询需联网；查询失败不阻塞抓轨（保留手动填写）。CD 抓轨与光盘抓取在
  disc.html 统一入口（手动选「视频光盘 / 音乐 CD」，任务运行中禁止切换类型，防并发读写
  同一光驱），但仍是两条独立流水线：前者走 `main/cdrip.js`（FFmpeg libcdio，输出 FLAC），
  后者走 `main/disc.js` + Rust 侧车（DVD/BD，输出 MKV/MP4），互不复用对方的单任务锁
- 字幕配音（dub）限制：Windows x64 的 CPU 与 Vulkan 两种后端**已在本机实测编出并跑通
  `--help`**（cmake 用 CLion 自带、VS 2022、Vulkan SDK 1.4.350.0），macOS 与 Windows arm64 的
  构建仍未验证。Windows x64 走 Vulkan（AMD/Intel 显卡首选，NVIDIA 也能跑但不如 CUDA 快），
  macOS 与 Windows arm64 **仅 CPU**（macOS 的 Metal 由 ggml 在 APPLE 下默认开启，MoltenVK
  未做）；运行期还要求机器有可用的 Vulkan 驱动，否则 Vulkan 版起不来。ggml 默认按**动态库**
  构建，`bin/tts/` 里必须同时有 `ggml*.dll`（缺了 tts-server 直接起不来）。模型是 talker +
  tokenizer 两个 GGUF，不随包分发，首次使用下载到 `userData/tts-models/`。talker 固定用
  **customvoice** 变体（`qwen-talker-1.7b-customvoice-<variant>.gguf`）：base 变体没有
  speaker_names、逐条字幕音色随机，已从代码里移除，**旧版本下过的 base 文件不会被识别**
  （文件名不同），升级后要重新下载一次。说话人取 `DEFAULT_SPEAKERS` 十项（与 GGUF 的
  `qwen3-tts.codec.speaker_names` 一致），合成请求逐条带 `voice` 与 `seed = 0`；说话人不影响
  识别/断句，只换音色。下载源可选官方
  HuggingFace、hf-mirror.com、ModelScope（页面「下载源」下拉，值 official / hfmirror /
  modelscope）：ModelScope 用的是第三方搬运仓库 `leletxh/Qwen3-TTS-GGUF`，只有 Q8_0 的两个
  文件，**选它并下载 Q4_K_M 时两个文件都会自动回退 hf-mirror**（控制台有 `[ffgui]` 日志）。
  下载优先用 aria2c：Windows 随包内置 `resources/aria2/aria2c.exe`
  （x64 为原生构建，WOA 用同一份 x64 由 Win11 系统模拟执行），macOS 随包内置原生编译的
  `resources/bin/aria2/aria2c`（静态 OpenSSL，`--with-ca-bundle=/etc/ssl/cert.pem`），Linux 与
  其他没有内置二进制的场合探 PATH；`FFGUI_ARIA2` 可指定可执行文件。aria2 走 `-c` 断点续传：
  取消/失败保留
  `.ffgui-partial` 与 `.aria2` 控制文件供下次续传，模型文件只在 aria2 退出码 0 后才 rename
  出现，不会被误认成已下载；四级探测都没命中才回退内置 https 实现，该路径失败即删半成品；
  一次下载内不切换实现。**macOS 的 aria2c 由 CI 现编**（官方没有 darwin 构建），编译失败时
  打包继续但没有内置二进制；WOA 的内置二进制是 x64，靠系统模拟运行。
  引擎缺失或启动失败必须明确报错，
  不能静默产出无人声音轨。引擎路径可用 `FFGUI_TTS_SERVER` 覆盖。默认输出策略是「源音轨全保留 +
  追加一条配音轨」，并把配音设为默认音轨（源音轨的 default 摘掉）；页面另有「混音输出」开关
  （job.mix），勾选后源音轨与配音 amix 成唯一一条音轨、源音轨不再单独存在，配音侧音量可调
  -30~+12 dB（mixVolumeDb）。**「只保留配音、丢掉原声」仍没有直接选项**：混音是叠加而不是替换，
  想完全去掉原声得等后续再加「替换原声」开关。字幕流的写法按**输出容器**选：MP4 系列转
  mov_text、其余 `-c:s copy`（混音分支用 `-map 0:s?`）。因此**源字幕是 mov_text 的 MP4 转 MKV
  会失败**（matroska 不支持 mov_text，报 `Subtitle codec mov_text is not supported`）——实测
  混音与多轨两个分支都一样，属既有行为，真要转化得改 `-c:s copy` 为按容器挑文本字幕编码器
  （图片字幕 PGS/VobSub 又要另走一路）。**附件流（attachment，含字体）只有 MKV 能装**：混音分支
  因为不再 `-map 0`，会显式 `-map 0:t?` + `-c:t copy` 保留（实测 MKV→MKV 字体附件字节一致），
  但 MP4 输出刻意不 map——硬 map 会让 mp4 muxer 报 `codec not currently supported in
  container` 直接失败，所以 MKV 源混音输出 MP4 时行为是「成功但丢附件」。多轨分支（`-map 0`
  + `-c copy`）在同样场景（MKV 带附件 → MP4）今天就会失败，仍属既有问题，未在本次改动范围内修。
  体积：Vulkan 版约 41MB
  （其中 `ggml-vulkan.dll` 38MB，含编译好的 shader），CPU 版约 2.5MB，安装包随之增大
