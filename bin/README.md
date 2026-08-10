# 放置 ffmpeg.exe 到这里

本目录用于存放 Windows 版 ffmpeg 可执行文件，运行时从这里加载（打包后会复制到 resources/bin/）。

## 获取方式

1. 下载 Windows 构建（推荐 gyan.dev 的 full 构建）：
   https://www.gyan.dev/ffmpeg/builds/ （选择 `ffmpeg-release-full.7z`）
2. 解压后将其中的 `ffmpeg.exe` 放入本目录（即 `bin/ffmpeg.exe`）。

macOS 不需要此文件，请通过 Homebrew 安装：`brew install ffmpeg`。
