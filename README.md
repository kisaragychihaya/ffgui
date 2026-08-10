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
