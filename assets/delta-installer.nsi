; =============================================================
; FFGui 增量更新安装包脚本（delta update）
; 由 scripts/build-delta.cjs 调用 tools/nsisbi/makensis.exe 编译
;
; 设计约束（见 docs/build-release.md）：
;   - 安装位置只从卸载注册表 HKCU\...\Uninstall\ffgui 的 InstallLocation 读取，
;     绝不重新推导/覆盖，快捷方式一律不动；
;   - 先补丁（ApplyPatch）后全量覆盖（ApplyCopy），最后删旧文件（ApplyRemove）；
;   - 补丁阶段任何失败都在小文件覆盖前退出，安装目录仍处于旧版可用状态；
;   - 静默（/S）成功后退回码 0 并重启应用，失败非 0；不带参数时用 MessageBox 报结果。
;
; 本文件含中文注释，makensis 只认带 BOM 的 UTF-8，因此 build-delta.cjs 编译前会
; 复制本文件并补 BOM，同时通过 GEN_DEFINES 注入版本、路径与 delta-files.nsh 位置。
; =============================================================

Unicode true
SetCompressor /SOLID lzma
SetCompressorDictSize 64
RequestExecutionLevel user
ShowInstDetails hide

!include "${GEN_DEFINES}"
!include "LogicLib.nsh"
!include "FileFunc.nsh"

Name "FFGui ${APP_VERSION} Delta"
OutFile "${OUT_FILE}"

VIProductVersion ${VI_VERSION}
VIAddVersionKey "ProductName" "FFGui"
VIAddVersionKey "FileDescription" "${FILE_DESCRIPTION}"
VIAddVersionKey "ProductVersion" "${APP_VERSION}"
VIAddVersionKey "FileVersion" "${APP_VERSION}"
VIAddVersionKey "LegalCopyright" "${LEGAL_COPYRIGHT}"
VIAddVersionKey "OriginalFilename" "${ORIGINAL_FILENAME}"

Var /GLOBAL LogHandle
Var /GLOBAL LogReady
Var /GLOBAL CmdRc
!if ${HAS_PATCHES} == 1
Var /GLOBAL CmdOut
!endif

; ---- 日志：DetailPrint + 追加到 $INSTDIR\delta-update.log（打开失败不影响安装） ----
!macro LogLine TEXT
  DetailPrint "${TEXT}"
  ${If} $LogReady == 1
    FileWrite $LogHandle "${TEXT}$\r$\n"
  ${EndIf}
!macroend

; ---- 失败即退出：退出码 1；静默模式只写日志，非静默额外弹窗 ----
!macro DeltaFail MSG
  !insertmacro LogLine "失败：${MSG}"
  ${If} $LogReady == 1
    FileClose $LogHandle
    StrCpy $LogReady 0
  ${EndIf}
  SetErrorLevel 1
  ${IfNot} ${Silent}
    MessageBox MB_ICONSTOP "增量更新失败：$\r$\n${MSG}$\r$\n$\r$\n请从发布页下载完整安装包重新安装。"
  ${EndIf}
  Quit
!macroend

; ---------------------------------------------------------------
; 逐文件指令（由 delta-files.nsh 展开）
; ---------------------------------------------------------------

; 补丁：源文件与补丁先复制到 $PLUGINSDIR，用纯 ASCII 的相对文件名解码，
; 成功后再用 NSIS（Unicode 安全）把结果覆盖回安装目录。
; 不能把 $INSTDIR 传给 xdelta3：xdelta3 3.1.0 使用 ANSI argv，而默认安装目录
; 是 %LOCALAPPDATA%\Programs\狒狒格式工具箱——非中文系统代码页会把中文路径
; 变成 ?，补丁必然失败。相对文件名不受 cwd 的 Unicode 路径影响。
; xdelta3 在补丁尾部校验目标校验和，源文件版本不符时解码会失败，旧文件保持不动。
!macro ApplyPatch REL PATCH
  !insertmacro LogLine "应用补丁：${REL}"
  ; 固定用 delta.patch / delta-source.bin / delta-target.bin，避免文件名含非 ASCII
  File "/oname=$PLUGINSDIR\delta.patch" "${PAYLOAD_DIR}\${PATCH}"
  Delete "$PLUGINSDIR\delta-source.bin"
  Delete "$PLUGINSDIR\delta-target.bin"
  CopyFiles /SILENT "$INSTDIR\${REL}" "$PLUGINSDIR\delta-source.bin"
  ${IfNot} ${FileExists} "$PLUGINSDIR\delta-source.bin"
    !insertmacro DeltaFail "复制源文件失败：${REL}"
  ${EndIf}
  nsExec::ExecToStack '"$SYSDIR\cmd.exe" /d /c cd /d "$PLUGINSDIR" && xdelta3.exe -f -d -s delta-source.bin delta.patch delta-target.bin'
  Pop $CmdRc
  Pop $CmdOut
  ${If} $CmdRc != 0
    !insertmacro LogLine "xdelta3 输出：$CmdOut"
    Delete "$PLUGINSDIR\delta-source.bin"
    Delete "$PLUGINSDIR\delta-target.bin"
    Delete "$PLUGINSDIR\delta.patch"
    !insertmacro DeltaFail "补丁解码失败（退出码 $CmdRc）：${REL}"
  ${EndIf}
  ${IfNot} ${FileExists} "$PLUGINSDIR\delta-target.bin"
    !insertmacro DeltaFail "补丁未生成新文件：${REL}"
  ${EndIf}
  ClearErrors
  CopyFiles /SILENT "$PLUGINSDIR\delta-target.bin" "$INSTDIR\${REL}"
  ${If} ${Errors}
    !insertmacro DeltaFail "替换文件失败：${REL}"
  ${EndIf}
  Delete "$PLUGINSDIR\delta-source.bin"
  Delete "$PLUGINSDIR\delta-target.bin"
  Delete "$PLUGINSDIR\delta.patch"
!macroend

; 全量覆盖：payload/ 下按相对路径镜像，目标目录由文件路径推导（不存在会自动创建）
!macro ApplyCopy REL
  !insertmacro LogLine "覆盖文件：${REL}"
  ${GetParent} "$INSTDIR\${REL}" $R0
  SetOutPath "$R0"
  ClearErrors
  File "/oname=$INSTDIR\${REL}" "${PAYLOAD_DIR}\${REL}"
  ${If} ${Errors}
    SetOutPath "$INSTDIR"
    !insertmacro DeltaFail "写入文件失败：${REL}"
  ${EndIf}
  SetOutPath "$INSTDIR"
!macroend

; 删除旧版独有文件；被占用时交给系统重启后删除
!macro ApplyRemove REL
  !insertmacro LogLine "删除旧文件：${REL}"
  Delete /REBOOTOK "$INSTDIR\${REL}"
!macroend

; ---------------------------------------------------------------
; 安装流程
; ---------------------------------------------------------------
Section "Delta"
  StrCpy $LogReady 0

  ; 1. 安装位置只认卸载注册表；读不到就退出，绝不猜测路径
  ReadRegStr $INSTDIR HKCU "${REG_UNINST}" "InstallLocation"
  ${If} $INSTDIR == ""
    SetErrorLevel 1
    ${If} ${Silent}
      ; 没有安装目录可写日志时落到 %TEMP%，便于客户端收集失败原因
      FileOpen $0 "$TEMP\ffgui-delta-update.log" w
      FileWrite $0 "未找到卸载注册表项 ${REG_UNINST} 的 InstallLocation，FFGui 可能未安装。$\r$\n"
      FileClose $0
    ${Else}
      MessageBox MB_ICONSTOP "未找到 FFGui 的安装位置（注册表 ${REG_UNINST}），无法执行增量更新。$\r$\n$\r$\n请先运行完整安装包。"
    ${EndIf}
    Quit
  ${EndIf}

  ${IfNot} ${FileExists} "$INSTDIR\${APP_EXE}"
    SetErrorLevel 1
    ${If} ${Silent}
      FileOpen $0 "$TEMP\ffgui-delta-update.log" w
      FileWrite $0 "InstallLocation 下找不到 ${APP_EXE}：$INSTDIR$\r$\n"
      FileClose $0
    ${Else}
      MessageBox MB_ICONSTOP "安装目录中找不到 ${APP_EXE}：$\r$\n$INSTDIR"
    ${EndIf}
    Quit
  ${EndIf}

  ClearErrors
  FileOpen $LogHandle "$INSTDIR\delta-update.log" w
  ${IfNot} ${Errors}
    StrCpy $LogReady 1
  ${EndIf}
  !insertmacro LogLine "FFGui 增量更新：${FROM_VERSION} -> ${APP_VERSION}"
  !insertmacro LogLine "安装目录：$INSTDIR"

  ; 只允许从声明过的旧版本升级，避免把补丁打到不匹配的文件上
  ReadRegStr $R0 HKCU "${REG_UNINST}" "DisplayVersion"
  ${If} $R0 != "${FROM_VERSION}"
    !insertmacro DeltaFail "当前版本 $R0 与增量包要求的 ${FROM_VERSION} 不一致"
  ${EndIf}

  ; 2. 结束正在运行的旧版本，等待文件句柄释放（taskkill 未找到进程时返回非 0，属正常）
  nsExec::Exec 'taskkill /F /IM "${APP_EXE}" /T'
  Pop $CmdRc
  !insertmacro LogLine "taskkill 退出码 $CmdRc（进程未运行时非 0，正常）"
  Sleep 2000

  ; 3. 补丁工具解到插件临时目录
  InitPluginsDir
!if ${HAS_PATCHES} == 1
  File /oname=$PLUGINSDIR\xdelta3.exe "${PAYLOAD_DIR}\xdelta3.exe"
!endif

  ; 4-5. 逐条展开 delta-files.nsh（补丁 → 全量覆盖 → 删除旧文件）
  !include "${DELTA_DATA}"

  ; 6. 更新卸载注册表：只改版本与体积，InstallLocation/快捷方式保持原样
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  WriteRegStr   HKCU "${REG_UNINST}" "DisplayVersion" "${APP_VERSION}"
  WriteRegDWORD HKCU "${REG_UNINST}" "EstimatedSize" "$0"

  ; 7. 完成日志
  !insertmacro LogLine "更新完成：${FROM_VERSION} -> ${APP_VERSION}"
  ${If} $LogReady == 1
    FileClose $LogHandle
    StrCpy $LogReady 0
  ${EndIf}

  ; 8. 静默模式重启应用；非静默显示结果
  ${If} ${Silent}
    Exec '"$INSTDIR\${APP_EXE}"'
  ${Else}
    MessageBox MB_ICONINFORMATION "增量更新完成：${FROM_VERSION} -> ${APP_VERSION}$\r$\n$\r$\n应用未自动启动，请手动打开。"
  ${EndIf}
SectionEnd
