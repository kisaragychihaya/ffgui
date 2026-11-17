# 构建与发布

面向 AI 编码代理的补充文档（由 AGENTS.md 索引）。改动构建流程、CI、安装器时同步更新本文。

## 构建与运行命令

- `npm install` / `npm ci` — 安装依赖
- `npm start` — 开发运行（`electron-forge start`，自动开 DevTools）
- `npm run package` — 打包到 `out/FFGui-win32-x64/`
- `npm run make` — Windows 生成 NSIS 安装包 `FFGui-<版本>-<x64|arm64>-Setup.exe`（MUI2 + 许可证
  页须同意 + 快捷方式「狒狒格式工具箱」，每用户安装无需管理员）
- `node scripts/build-tts.cjs [--backend vulkan|cpu] [--arch x64|arm64] [--no-native] [--clean]` — 编译
  TTS 引擎到 `bin/tts/`（可选：不编则打包时跳过 bin/tts/，字幕配音回退 PATH；需先
  `git submodule update --init --recursive` 与 cmake，Vulkan 后端另需 Vulkan SDK）
- `bin/aria2/aria2c[.exe]`（模型下载断点续传）没有本地构建脚本：Windows 直接放 aria2 官方
  x64 构建（WOA 也用它，Win11 模拟执行），macOS 需要自己编静态版本（配方见
  `docs/build-release.md` 的 CI 段落与 `bin/README.md`）；缺失不影响打包（forge 只在该目录
  存在时处理它，运行时回退 PATH 探测与内置 https 下载）

`npm test` 用 Node 内置测试运行器（`scripts/regression.test.cjs`），需 PATH 中有 ffmpeg/ffprobe
或设置 `FFMPEG` / `FFPROBE`。没有 lint/format 配置。

## 增量更新包（Windows delta update）

发版时除全量安装包外，还会对上一个正式 Release 生成 `delta-update-<版本>-<arch>.exe`
（就地补丁安装器）与 `delta-update-<版本>-<arch>.json`（清单），由
`scripts/build-delta.cjs` 生成、`assets/delta-installer.nsi` 编译，CI 只在
`windows` / `windows-arm64` 两个 job 的 Release 触发时执行（macOS 不涉及）。
客户端 `main/updater.js` 读取该清单：`fromVersion` 等于当前版本、`arch` 匹配、
每个 `xdelta3` 条目的 `sourceSha256` 与本地文件一致时才下载增量包，否则回退全量安装包。

本地/CI 用法：

```bash
node scripts/build-delta.cjs \
  --app-dir out/FFGui-win32-x64 \
  --prev-dir <上一个 Release 的 unpacked 目录> \
  --xdelta3 <xdelta3.exe> \
  --out-dir out/make/delta/x64 \
  --arch x64 --version 0.7.5 --from-version 0.7.4
```

- 递归对比两目录的相对路径（正斜杠）：新增/变更写入 `payload/`，删除写入 `removed`；
  内容一致的文件不会进包。
- `size > 1MB` 的变更文件优先用 `xdelta3 -f -e -S lzma -9 -s 旧 新 patch` 生成补丁，
  **生成后立刻回放**并与新文件 sha256 比对；xdelta3 缺失/超时/失败/回放不一致时该文件
  回退 `method=copy`（全量打进包里）。补丁名默认用 basename，不同目录同名时改用
  `path.replace(/\//g,'__')`，实际名写入 `manifest.patch`。
- `payload/` 下：全量文件按相对路径镜像、补丁平铺在 `patches/`、`xdelta3.exe` 在根；
  `delta-files.nsh` 由脚本生成（补丁 → 全量覆盖 → 删除），由安装器 `!include` 展开。
- 清单契约（字段名不得改）：`schema/version/fromVersion/arch/package/packageSha256/
  fullSetup/files[]/removed[]`。`packageSha256` 在安装包编译完成后回填；
  `delta-update-<版本>-<arch>.json` 即 Release 资产名，另存一份 `manifest.json` 便于排查。
- 安装器行为顺序：读 HKCU 卸载注册表 `InstallLocation`（读不到/目录无 `FFGui.exe`/
  `DisplayVersion != fromVersion` 均退出 1，静默时写 `%TEMP%\ffgui-delta-update.log`）
  → `taskkill /F /IM FFGui.exe /T` + `Sleep 2000` → 解 `xdelta3.exe` 到 `$PLUGINSDIR`
  → 逐条补丁（源文件与补丁复制到 `$PLUGINSDIR`，用纯 ASCII 相对文件名调用 xdelta3
  解码——xdelta3 3.1.0 是 ANSI argv，不能直接接触含中文的安装路径；校验产物存在后用
  NSIS 覆盖回原文件；失败即退出，此前只应用了更早的补丁，小文件尚未覆盖）→ 逐条全量覆盖
  → 逐条 `Delete /REBOOTOK` 旧文件
  → 只更新 `DisplayVersion` 与 `EstimatedSize`（`InstallLocation`/快捷方式/卸载器不动）
  → 写 `$INSTDIR\delta-update.log`（ANSI/系统代码页）→ 静默模式重启应用，非静默弹窗。
- 退出码：成功 0，失败非 0；`/S` 由客户端自动更新调用，不带参数运行也会执行并在结束时弹窗。
- CI 步骤：查上一个正式 Release（非 draft/prerelease）→ 下载其 `FFGui-windows-<arch>.7z`
  与 `FFGui-<旧版本>-<arch>-Setup.exe`、下载 xdelta3（资产实名
  `xdelta3-3.1.0-x86_64.exe.zip`，解压后重命名）→ 生成 → x64 额外跑冒烟
  （静默装旧版 → delta → 校验 FFGui.exe/app.asar 哈希、`DisplayVersion`、快捷方式目标
  未变 → 卸载）→ 上传 artifact 与 Release Assets。所有下载/解压都在 `$RUNNER_TEMP`；
  任一步失败或上一个 Release 缺产物只跳过增量包，不影响全量发版。
- 已知限制：`fromVersion` 取上一个 Release 的 tag（去 `v`），因此 tag 必须与
  `package.json` 版本一致，否则客户端判定不适用并回退全量；补丁按文件逐个替换，
  第二个补丁失败时前面的补丁已生效（xdelta3 会校验目标，失败概率低）；补丁阶段的
  失败不会覆盖小文件，旧版仍可启动。

## 部署 / CI

`.github/workflows/build.yml`（workflow_dispatch 手动触发、发布 Release 时触发，
或每 5 天定时触发一次刷新 actions/cache；定时构建只传 artifact、不上 Release Assets）：

- Windows x64：从 GyanD/codexffmpeg 最新 release 下载 full_build.7z（gyan.dev 直链在 CI 上会被
  反爬拦截），取 `ffmpeg.exe` 放入 `bin/`；从 aria2 官方 Release 下载
  `release-1.37.0/aria2-1.37.0-win-64bit-build1.zip`（解压到 `$RUNNER_TEMP`），取 `aria2c.exe`
  放入 `bin/aria2/`（模型下载断点续传用）；
  dtolnay/rust-toolchain 构建 Rust 侧车并复制为
  `bin/disc/ffgui-disc.exe`；Vulkan SDK 为自解（humbletim action 对新版 Qt IFW
  安装包只能解出 Bin/，无人值守安装又要求提权写注册表，均不可用）：7z 解主归档拿
  Bin/，再按 7z magic 把内嵌组件负载（Lib/Include/cmake 等）逐个 carve 出来，装到
  `$RUNNER_TEMP/VULKAN_SDK`（刻意不进仓库根目录，避免又被打进 app.asar——x64 安装包
  曾因此 625MB）；装好后 `node scripts/build-tts.cjs --backend vulkan --no-native`
  构建 TTS 引擎到 `bin/tts/`
  （Vulkan 失败自动回退 `--backend cpu`，两者都失败只写警告并建空 `bin/tts/`，打包继续）；
  `npm ci` + `npm run package`，再经 `scripts/build-installer.cjs` 生成 NSIS 安装包；
  `FFGui-windows-x64.7z` 与 `FFGui-<版本>-x64-Setup.exe` 上传 artifact；Release 触发时同时
  上传到 Release Assets
- Windows arm64：在 **windows-11-arm 原生 ARM64 runner** 上构建（公共仓库免费、已 GA，
  原生编译免掉交叉工具链的 MSVC 链接器配置等坑，产物可直接执行冒烟）；ffmpeg 从
  tordona/ffmpeg-win-arm64 最新 release 下载 full-static-win-arm64.7z 取
  `ffmpeg.exe` 放入 `bin/`（PE 头 0xAA64 校验 + 原生执行双重验证）；cargo 原生构建
  侧车（host triple 即 aarch64-pc-windows-msvc，ring 的 ARM64 汇编仍需 clang）；
  TTS 引擎 **Vulkan 优先**（ARM64 Vulkan SDK 与 x64 同版本号发布，下载路径为
  `sdk.lunarg.com/sdk/download/<版本>/warm/vulkansdk-windows-ARM64-<版本>.exe`，
  carve 解包逻辑同 x64；ARM64 包内部布局未完全实测，下载/解包/校验任一步失败只警告），
  失败回退 `--backend cpu`（注意：ggml 要求 MSVC ARM 必须 GGML_NATIVE=ON，
  `--no-native` 在 win32+arm64 下由 build-tts.cjs 自动忽略，且该路径不追加宿主专属指令）；
  `npm run package -- --arch=arm64`，产物 `FFGui-windows-arm64.7z` +
  `FFGui-<版本>-arm64-Setup.exe`（NSISBI 为 x86 二进制，在 Win11 ARM 上经系统模拟运行）。
  aria2c 用**官方 x64 构建**（Win11 ARM 系统模拟）：aria2 官方、`abcfy2/aria2-static-build`
  都没有 arm64 Windows 资产，工作流先探一次上游（有了会自动改用原生 asset），PE 头
  0x8664/0xAA64 分别校验；下载失败只警告，缺 `bin/aria2/` 时 forge 自动跳过
- macOS：下载 kisaragychihaya/ffmpeg_build_mac 最新 release 的 macos-arm64-static tar.gz，
  `bin/` 与 `lib/` 原样放入项目 `bin/` 并 `chmod +x`；cargo 构建侧车到 `bin/disc/ffgui-disc`；
  **原生编译 aria2c**：官方没有 macOS 构建，用官方 `aria2-1.37.0.tar.gz`（自带 configure）
  + brew `openssl@3` 的静态库（`libssl.a`/`libcrypto.a` 放到只含 `.a` 的暂存目录，让链接器
  命中静态库），`./configure --with-openssl --with-ca-bundle=/etc/ssl/cert.pem
  --without-{gnutls,appletls,libgcrypt,libnettle,libssh2,libxml2,libexpat,sqlite3,libgmp,libcares,libuv}
  --disable-{bittorrent,metalink,websocket} ARIA2_STATIC=yes` → `bin/aria2/aria2c`；
  产物用 `otool -L` 校验不引用 `/opt/homebrew`（用户机器没有 brew），编译失败只警告；
  `node scripts/build-tts.cjs --backend cpu --no-native` 构建 tts-server 到 `bin/tts/`（Metal
  由 ggml 在 APPLE 下默认开启，MoltenVK 暂不涉及）；打包后用 ditto 压缩为
  `FFGui-macos-arm64.zip`；Release 触发时同样上传。
  **CD 抓轨要求该构建带 `--enable-libcdio`**（工作流 configure 里显式开启，未开则
  macOS 上读不出 CD 的 TOC）
- TTS 引擎：源码是 submodule `native/qwentts.cpp`，三个 job 的 checkout 都必须是
  `submodules: recursive`（qwentts.cpp 内部还套着 ggml 子模块，缺了 cmake 配置会直接失败）；
  二进制不入库，每平台按上面的后端现编，**产物走 actions/cache**：键为
  `tts-v1-<平台>-<架构>-<后端>-<qwentts.cpp SHA>[-<Vulkan SDK 版本>]-<build-tts.cjs 哈希>`
  （`v1` 是手动失效位，改缓存策略时递增），命中即跳过编译，Windows x64 连 Vulkan SDK
  安装四步一起跳过。防污染：构建成功后往 `bin/tts/.backend` 写实际后端标记，**只有主后端
  构建成功才保存缓存**（x64 回退的 CPU 产物绝不写入 vulkan 键），恢复时也校验标记，
  校验不过按未命中重建（重建前先清空 `bin/tts/`，避免残留 dll 混入）；保存步骤带
  `continue-on-error`（缓存键不可变，同名键已存在时保存报错不应拖垮 job）。
  Windows x64 的 CPU/Vulkan 构建与 `bin/tts/` 产物布局
  已在本机实测（产物为 `build/Release/tts-server.exe` + 同目录 `ggml*.dll`，tts-server 需与
  dll 同目录才能启动）；**ARM64 Vulkan SDK 的 carve 解包与 Vulkan 版 tts-server 已在
  windows-11-arm runner 上实测通过**（动态后端 ggml-vulkan.dll 随产物分发）；**仍未验证**
  的是 macOS 构建。
  Vulkan SDK 自解流程已按 1.4.363.1 本机完整验证（carve + 用其编出 Vulkan 版 tts-server），
  工作流里有 ggml 三件套布局校验，LunarG 再改打包格式会显式失败并回退 CPU 后端
- 仓库不提交 `bin/ffmpeg.exe`、`bin/aria2/` 等二进制，CI 每次现下；NSISBI 编译器同样不入库，
  构建时从 v0.1 Release 资源下载解压
