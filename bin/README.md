# 放置内置可执行文件到这里

本目录用于存放各平台的 ffmpeg 可执行文件、TTS 引擎（tts-server）与 aria2c（模型下载用），
运行时从这里加载（打包后会复制到 resources/，见 forge.config.js 的 extraResource）。

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

## TTS 引擎 tts-server（字幕配音）

字幕配音（`main/dub.js`）通过 OpenAI 兼容 HTTP 接口调用本地 TTS 引擎 `tts-server`，
引擎源码是 git submodule `native/qwentts.cpp`（fork 自 ServeurpersoCom/qwentts.cpp，
自带 ggml 子模块）。产物位置约定：

- Windows：`bin/tts/tts-server.exe`
- macOS：`bin/tts/tts-server`
- Linux：不携带，主进程回退系统 PATH 中的 `tts-server`

`bin/tts/` 与 `bin/disc/` 一样不入库（见 .gitignore），需自行编译；打包时随
extraResource 复制到 `resources/tts/`。模型（GGUF）不随包分发，首次使用由
`main/dub.js` 下载到 `userData/tts-models/`。

### 取源码

```sh
git submodule update --init --recursive   # 必须加 --recursive：qwentts.cpp 里还有 ggml 子模块
```

### 一键构建（推荐）

```sh
node scripts/build-tts.cjs                  # 按平台自动选后端：Windows x64 = Vulkan，其余 = CPU
node scripts/build-tts.cjs --backend cpu    # 强制 CPU 后端
node scripts/build-tts.cjs --no-native      # 关掉宿主 CPU 优化，产物可分发到其他机器
node scripts/build-tts.cjs --clean          # 先删子模块的 build/ 再配置
```

脚本封装了下面的 cmake 配置/编译/拷贝，产物直接落到 `bin/tts/`。无 cmake 时报中文错误。

### 手动构建

前置：cmake（3.19+）。Vulkan 后端还需要**完整 Vulkan SDK**（Windows：
https://vulkan.lunarg.com/sdk/home ；CI 用 `humbletim/install-vulkan-sdk` 安装）——
ggml 的 `ggml/src/ggml-vulkan/CMakeLists.txt` 要求 `find_package(Vulkan COMPONENTS glslc
REQUIRED)` 与 `find_package(SPIRV-Headers CONFIG REQUIRED)`，并读取 `VULKAN_SDK`
环境变量，仅放一个 `glslangValidator` 不够。

Windows（Vulkan，主力后端；需在「x64 Native Tools Command Prompt for VS」里执行）：

```bat
cd native\qwentts.cpp
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DGGML_VULKAN=ON
cmake --build build --config Release --target tts-server -j %NUMBER_OF_PROCESSORS%
if not exist ..\..\bin\tts mkdir ..\..\bin\tts
copy build\Release\tts-server.exe ..\..\bin\tts\tts-server.exe
copy build\Release\*.dll ..\..\bin\tts\
```

Windows（CPU）：把上面的 `-DGGML_VULKAN=ON` 换成 `-DGGML_VULKAN=OFF` 重跑一遍（先删 `build\`）。

macOS（CPU；Metal 在 APPLE 下由 ggml 默认开启，MoltenVK/Vulkan 暂不支持）：

```sh
cd native/qwentts.cpp
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DGGML_VULKAN=OFF
cmake --build build --config Release --target tts-server -j "$(getconf _NPROCESSORS_ONLN)"
mkdir -p ../../bin/tts
cp build/tts-server ../../bin/tts/ && chmod +x ../../bin/tts/tts-server
cp build/*.dylib ../../bin/tts/ 2>/dev/null || true   # ggml 以动态库构建，缺了起不来
```

产物路径说明：`native/qwentts.cpp/CMakeLists.txt` 把 `CMAKE_RUNTIME_OUTPUT_DIRECTORY`
设为构建根目录，所以单配置生成器（Makefiles/Ninja）产出 `build/tts-server(.exe)`，
多配置生成器（Visual Studio）产出 `build/Release/tts-server(.exe)`。

**ggml 默认按动态库构建**（本机实测 Windows CPU 版：tts-server.exe 0.8MB +
ggml.dll / ggml-base.dll / ggml-cpu.dll，Vulkan 版另有 ggml-vulkan.dll，合计约几 MB），
这些 DLL/dylib 必须和可执行文件放在同一目录，否则 tts-server 启动即失败。
`scripts/build-tts.cjs` 会自动把它们一起拷到 `bin/tts/`；手工构建时别漏。

### 开发调试

- 用 `FFGUI_TTS_SERVER` 环境变量可覆盖引擎路径，跳过 `bin/tts/` 查找（例如指向自己编译的
  `native/qwentts.cpp/build/Release/tts-server.exe`，同目录要有 `ggml*.dll`）
- `tts-server` 的命令行参数：`--model <gguf> --codec <gguf> [--device Vulkan0|CPU0]
  [--host 127.0.0.1] [--port 8080] [--alias <name>]`；也可用环境变量 `MODEL_PATH` / `CODEC_PATH`

## aria2c（模型下载断点续传）

字幕配音的模型下载优先用 aria2c（`-c` 断点续传，取消/失败保留半成品），`main/dub.js` 的
`resolveAria2` 按「注入 → `FFGUI_ARIA2` → 内置 `bin/aria2/aria2c.exe` → PATH 探测」找它。

- 只有 **Windows x64** 内置：aria2 官方 Release 只发布 win-64bit 构建，没有 Windows arm64
  与 macOS 版本，这两个平台跳过内置、运行时探 PATH，都没有时回退内置 https 下载
  （功能可用，但没有断点续传）
- 位置约定：开发 `bin/aria2/aria2c.exe`，打包后经 extraResource 落到 `resources/aria2/`
- 来源：官方 Release 的 `aria2-1.37.0-win-64bit-build1.zip`
  （https://github.com/aria2/aria2/releases/download/release-1.37.0/aria2-1.37.0-win-64bit-build1.zip），
  解开取其中的 `aria2c.exe` 放入本目录
- `bin/aria2/` 同样不入库（见 .gitignore），CI 每次现下（Windows x64 job 的
  「下载 aria2c 并放入 bin/aria2」步骤）
- 调试时可用 `FFGUI_ARIA2` 指定任意 aria2c 完整路径（会先跑 `aria2c --version` 自检，
  不可用则继续尝试内置与 PATH）
