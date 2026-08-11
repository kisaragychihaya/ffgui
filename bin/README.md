# 放置 ffmpeg 可执行文件到这里

本目录用于存放各平台的 ffmpeg 可执行文件，运行时从这里加载（打包后会复制到 resources/bin/）。

- Windows：`bin/ffmpeg.exe`
- macOS：`bin/bin/ffmpeg`（动态库在 `bin/lib/`，相对布局不能变）；
  未放置时回退到 Homebrew 安装的 ffmpeg
- Linux：不内置，使用系统 PATH 中的 ffmpeg

## 获取方式

### Windows

1. 下载 Windows 构建（推荐 gyan.dev 的 full 构建）：
   https://www.gyan.dev/ffmpeg/builds/ （选择 `ffmpeg-release-full.7z`）
2. 解压后将其中的 `ffmpeg.exe` 放入本目录（即 `bin/ffmpeg.exe`）。

### macOS

使用自建预编译构建：https://github.com/kisaragychihaya/ffmpeg_build_mac/releases
下载 `ffmpeg-full-macos-arm64-static.tar.gz`（混合静态构建，体积更小，
能力与 shared 版一致；无 .a 的库仍动态链接），解压后把其中的 `bin/` 和
`lib/` 两个目录原样放入本目录（即 `bin/bin/ffmpeg`、`bin/lib/*.dylib`），
并 `chmod +x bin/bin/ffmpeg`。

也可以不放置，直接通过 Homebrew 安装：`brew install ffmpeg`。
注意：Homebrew 官方源的 ffmpeg 未编译 zimg（缺少 zscale 滤镜），
使用「HDR 转 SDR」需要带 zimg 的构建（上述自建版本已包含）。
