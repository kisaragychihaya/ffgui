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

## 运行与开发

### 音轨与输出文件

- 转码默认保留全部音轨；可填写从 1 开始的音轨序号，只输出指定轨道。批量任务使用每个文件自己的音轨顺序。
- MP3、FLAC、WAV、FLV 使用单音轨模式，多音轨输入须明确选轨；不会自动丢弃其他音轨。需要全部音轨时可选择 MKV 或 M4A 等格式。
- MKV 转码同时保留字幕和附件；其他转码容器仅输出所选视频、音频，不自动转换字幕或附件。
- 无损截取映射全部原始流；若原格式无法重新封装某类流，任务会报错，不静默丢弃。时间输入与滑块保留毫秒，无损切仍受关键帧限制。
- 合并按音轨序号逐路拼接，缺轨片段补静音。合并前需确保各文件语言轨顺序一致；每条音轨沿用 44.1 kHz 双声道重采样规则。
- 转码、截取、合并遇到已有文件或批内同名输出时自动编号，避免覆盖源文件和历史结果。

### 回归测试

`npm test` 使用 Node 内置测试运行器，无需安装额外测试框架。运行前将 ffmpeg 和 ffprobe 加入 PATH，也可以用 `FFMPEG`、`FFPROBE` 环境变量指定路径。测试用 FFmpeg 需要包含 libx264、AAC、libmp3lame、FLAC 和 subtitles 滤镜。

测试会生成临时媒体并在结束后清理，覆盖多音轨转码/截取/合并、选轨、字幕附件、输出防覆盖、进度拆包和毫秒时间。完整应用手工验证仍使用 `npm start`。

```bash
npm install
npm start          # 开发运行
npm run package    # 打包（输出到 out/）
npm run make       # 生成安装包（Windows: Squirrel / macOS: zip / Linux: deb、rpm）
```

### ffmpeg 获取

- **Windows**：下载 ffmpeg 构建（推荐 [gyan.dev full 构建](https://www.gyan.dev/ffmpeg/builds/)），
  将 `ffmpeg.exe` 放入项目 `bin/` 目录（详见 `bin/README.md`）
- **macOS**：`brew install ffmpeg`
- **Linux**：使用发行版包管理器安装 ffmpeg（走系统 PATH）

## 技术栈

- Electron 41，无前端框架、无打包器：渲染层为原生 HTML / CSS / JS
- 主进程负责 ffmpeg 能力探测与缓存、文件对话框、spawn ffmpeg 并解析 `-progress` 进度输出
- 渲染进程通过 preload 的 contextBridge 访问受限 IPC API（contextIsolation 开启）

## 许可证

LGPL-3.0-or-later
