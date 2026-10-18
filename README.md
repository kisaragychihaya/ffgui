# FFGui

基于 Electron + FFmpeg 的桌面音视频工具箱（GUI for FFmpeg），界面语言为简体中文。

## 功能

### 音视频转码

- 批量队列转码：拖入或选择多个文件，按队列顺序逐个处理，实时显示每个文件的进度
- 能力自动探测：首次启动时通过 `ffmpeg -hwaccels / -encoders / -formats` 探测本机真实支持的
  硬件加速、编码器、封装格式并缓存；硬件编码器会逐个试编码实测，驱动不支持的自动剔除
  （如 NVENC / QSV / AMF / MediaFoundation / VideoToolbox）
- 常用格式与编码：MP4 / MKV / AVI / MOV / WebM / GIF / MP3 / FLAC 等，
  H.264 / H.265 / AV1 / VP9 / ProRes 等
- 高级参数：视频码率（VBR / CBR）、音频码率、分辨率缩放（宽x高 或百分比），
  留空则不传参，由 ffmpeg 使用默认值
- HDR 转 SDR：基于 zscale + tonemap 的色调映射
- 纯音频提取：输出 MP3 / FLAC / WAV 等时自动去掉视频流

### 音视频合并

- 拖入视频或音频，按住手柄上下拖动调整拼接顺序
- 纯音频队列：只拼接音频（无损重采样对齐）
- 混合队列：自动重编码拼接，不同格式/分辨率可直接混合；
  队列中的音频文件会以黑屏画面合并进视频，无音轨的视频段自动补静音

### 画面裁剪

- 单文件可视化画框：选择或拖入一个视频，原生播放器暂停到某一帧后，
  点击「绘制裁剪框」在视频实际显示画面上拖拽框选要保留的区域，
  支持任意方向拖拽、边界钳制、选框外压暗，框太小直接判无效
- 选框按画面比例保存为归一化坐标（0~1），与预览画质无关；
  浏览器放不了的格式会自动生成低画质预览副本用于播放与画框，
  最终转换始终使用原文件，输出 MP4 / H.264 / AAC 并保留全部音轨
- 可调输出质量（高 / 标准 / 低）与输出目录，支持进度显示与取消；
  导出宽高会向下取偶数（如 1919→1918），已有文件自动避让不覆盖

### 光盘抓取

- 支持 DVD / Blu-ray 的 ISO 镜像、已提取目录（VIDEO_TS / BDMV）和物理光驱
- 探测标题、时长、章节、音轨和字幕语言；默认选最长标题，可多选标题逐条抓取
- 音轨/字幕三态选择：全部保留、一条不保留、或逐项指定，避免静默丢轨
- 无损 MKV：直接复制视频流；转码 MKV / MP4：H.264 + 可选 AAC，
  质量高/标准/低，保留章节；MP4 不支持 PGS / VobSub 图像字幕，需主动选择不保留
- 加密蓝光需自备本地 KEYDB.cfg；在线密钥服务不启用
- 物理光驱与加密盘的兼容性仍需真机验证

## 运行与开发

### 音轨与输出文件

- 转码默认保留全部音轨；可填写从 1 开始的音轨序号，只输出指定轨道。批量任务使用每个文件自己的音轨顺序。
- MP3、FLAC、WAV、FLV 使用单音轨模式，多音轨输入须明确选轨；不会自动丢弃其他音轨。需要全部音轨时可选择 MKV 或 M4A 等格式。
- MKV 转码同时保留字幕和附件；其他转码容器仅输出所选视频、音频，不自动转换字幕或附件。
- 无损截取映射全部原始流；若原格式无法重新封装某类流，任务会报错，不静默丢弃。时间输入与滑块保留毫秒，无损切仍受关键帧限制。
- 画面裁剪输出单个 MP4（H.264 + AAC），选框为相对视频画面的归一化矩形，按原视频实际分辨率等比例换算后裁剪；预览副本上框选的区域与输出区域按同一比例对应。
- 合并按音轨序号逐路拼接，缺轨片段补静音。合并前需确保各文件语言轨顺序一致；每条音轨沿用 44.1 kHz 双声道重采样规则。
- 转码、截取、合并遇到已有文件或批内同名输出时自动编号，避免覆盖源文件和历史结果。

### 回归测试

`npm test` 使用 Node 内置测试运行器，无需安装额外测试框架。运行前将 ffmpeg 和 ffprobe 加入 PATH，也可以用 `FFMPEG`、`FFPROBE` 环境变量指定路径。测试用 FFmpeg 需要包含 libx264、AAC、libmp3lame、FLAC 和 subtitles 滤镜。

测试会生成临时媒体并在结束后清理，覆盖多音轨转码/截取/合并、选轨、字幕附件、输出防覆盖、进度拆包和毫秒时间。完整应用手工验证仍使用 `npm start`。

```bash
npm install
npm start          # 开发运行
npm run package    # 打包（输出到 out/）
npm run make       # 生成安装包（Windows: NSIS / macOS: zip / Linux: deb、rpm）
```

### ffmpeg 获取

- **Windows**：下载 ffmpeg 构建（推荐 [gyan.dev full 构建](https://www.gyan.dev/ffmpeg/builds/)），
  将 `ffmpeg.exe` 放入项目 `bin/` 目录（详见 `bin/README.md`）
- **macOS**：`brew install ffmpeg`
- **Linux**：使用发行版包管理器安装 ffmpeg（走系统 PATH）

## 技术栈

- Electron 41，无前端框架、无打包器：渲染层为原生 HTML / CSS / JS
- 主进程负责 ffmpeg 能力探测与缓存、文件对话框、spawn ffmpeg 并解析 `-progress` 进度输出
- 光盘抓取由 Rust 侧车调用 freemkv-engine 完成读盘与无损封装，FFmpeg 负责后续转码
- 渲染进程通过 preload 的 contextBridge 访问受限 IPC API（contextIsolation 开启）

## 参考引用

- [freemkv](https://github.com/freemkv/freemkv) — 光盘抓取所用的 freemkv-engine 上游项目（Rust 侧车基于它完成读盘与无损 MKV 封装）
- [FFmpeg](https://git.ffmpeg.org/ffmpeg.git) — 本项目内置并调用的音视频处理引擎

## 许可证

LGPL-3.0-or-later
