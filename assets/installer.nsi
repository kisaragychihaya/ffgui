; =============================================================
; FFGui（狒狒格式工具箱）Windows 安装包脚本
; 由 scripts/build-installer.cjs 调用 tools/nsisbi/makensis.exe 编译
;
; 本文件含中文注释，但仓库内保存为无 BOM UTF-8（方便编辑）；
; makensis 只认带 BOM 的 UTF-8，因此 build-installer.cjs 编译前会复制本文件
; 并补上 UTF-8 BOM。产品名、版本、路径等通过 GEN_DEFINES
; （构建时生成的 UTF-8 BOM defines.nsh）注入。
; =============================================================

Unicode true
SetCompressor /SOLID lzma
; 固实压缩配合更大的字典提升压缩率（解压端内存占用约 64MB+，可接受）
SetCompressorDictSize 64
ManifestDPIAware true

!include "${GEN_DEFINES}"

Name "${APP_NAME}"
OutFile "${OUT_FILE}"
InstallDir "$LOCALAPPDATA\Programs\${APP_NAME}"
RequestExecutionLevel user
ShowInstDetails show

!include "MUI2.nsh"
!include "FileFunc.nsh"

; ---- 现代界面（MUI2）配置 ----
!define MUI_ABORTWARNING
!define MUI_ICON "${ICON_FILE}"
!define MUI_UNICON "${ICON_FILE}"
; 完成页提供“运行应用”复选框（文案按语言，见下方 LangString）
!define MUI_FINISHPAGE_RUN "$INSTDIR\${APP_EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "$(RUN_TEXT)"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "${LICENSE_FILE}"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

; ---- 语言：NSIS 默认按系统显示语言自动选择（$LANGUAGE 初始值），
;      系统语言不在列表里时用**第一个**插入的语言，故 English 放在最前 = 兜底英文。
;      MUI_LANGUAGE 必须最后插入（在所有页面宏之后）。 ----
!insertmacro MUI_LANGUAGE "English"      ; 兜底：非中文/日/韩系统显示英文
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "TradChinese"
!insertmacro MUI_LANGUAGE "Japanese"
!insertmacro MUI_LANGUAGE "Korean"

; ---- 自定义文案（MUI 自带的按钮/页面文字由语言文件本地化，无需在此重复） ----
; 产品名（${APP_NAME}）是品牌名，各语言保持一致，安装目录与快捷方式因此不随语言变化
LangString SECTION_MAIN   ${LANG_ENGLISH}    "Main program"
LangString SECTION_MAIN   ${LANG_SIMPCHINESE} "主程序"
LangString SECTION_MAIN   ${LANG_TRADCHINESE} "主程式"
LangString SECTION_MAIN   ${LANG_JAPANESE}    "メインプログラム"
LangString SECTION_MAIN   ${LANG_KOREAN}      "주 프로그램"

LangString SECTION_UNINST ${LANG_ENGLISH}    "Uninstall"
LangString SECTION_UNINST ${LANG_SIMPCHINESE} "卸载"
LangString SECTION_UNINST ${LANG_TRADCHINESE} "解除安裝"
LangString SECTION_UNINST ${LANG_JAPANESE}    "アンインストール"
LangString SECTION_UNINST ${LANG_KOREAN}      "제거"

LangString RUN_TEXT       ${LANG_ENGLISH}    "Run ${APP_NAME}"
LangString RUN_TEXT       ${LANG_SIMPCHINESE} "运行 ${APP_NAME}"
LangString RUN_TEXT       ${LANG_TRADCHINESE} "執行 ${APP_NAME}"
LangString RUN_TEXT       ${LANG_JAPANESE}    "${APP_NAME} を起動"
LangString RUN_TEXT       ${LANG_KOREAN}      "${APP_NAME} 실행"

LangString UNINSTALL_LNK  ${LANG_ENGLISH}    "Uninstall ${APP_NAME}"
LangString UNINSTALL_LNK  ${LANG_SIMPCHINESE} "卸载${APP_NAME}"
LangString UNINSTALL_LNK  ${LANG_TRADCHINESE} "解除安裝${APP_NAME}"
LangString UNINSTALL_LNK  ${LANG_JAPANESE}    "${APP_NAME} をアンインストール"
LangString UNINSTALL_LNK  ${LANG_KOREAN}      "${APP_NAME} 제거"

LangString BRANDING_TEXT  ${LANG_ENGLISH}    "${APP_NAME} ${APP_VERSION} Setup"
LangString BRANDING_TEXT  ${LANG_SIMPCHINESE} "${APP_NAME} ${APP_VERSION} 安装程序"
LangString BRANDING_TEXT  ${LANG_TRADCHINESE} "${APP_NAME} ${APP_VERSION} 安裝程式"
LangString BRANDING_TEXT  ${LANG_JAPANESE}    "${APP_NAME} ${APP_VERSION} セットアップ"
LangString BRANDING_TEXT  ${LANG_KOREAN}      "${APP_NAME} ${APP_VERSION} 설치 프로그램"

BrandingText "$(BRANDING_TEXT)"

; ---- 安装包 exe 自身版本信息 ----
VIProductVersion ${VI_VERSION}
VIAddVersionKey "ProductName" "${APP_NAME}"
VIAddVersionKey "FileDescription" "${FILE_DESCRIPTION}"
VIAddVersionKey "ProductVersion" "${APP_VERSION}"
VIAddVersionKey "FileVersion" "${APP_VERSION}"
VIAddVersionKey "LegalCopyright" "${LEGAL_COPYRIGHT}"
VIAddVersionKey "OriginalFilename" "${ORIGINAL_FILENAME}"

; =============================================================
Section "$(SECTION_MAIN)" SEC_INSTALL
  SectionIn RO

  ; 安装前先结束正在运行的旧版本进程，避免文件占用导致升级失败
  nsExec::Exec "taskkill /F /IM ${APP_EXE} /T"
  Pop $0

  SetOutPath "$INSTDIR"
  File /r "${APP_DIR}\*.*"

  WriteUninstaller "$INSTDIR\${UNINSTALL_EXE}"

  ; 开始菜单快捷方式（含卸载入口）
  CreateDirectory "$SMPROGRAMS\${APP_NAME}"
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}"
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\$(UNINSTALL_LNK).lnk" "$INSTDIR\${UNINSTALL_EXE}"
  ; 桌面快捷方式
  CreateShortcut "$DESKTOP\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}"

  ; 注册“应用和功能”卸载信息（仅当前用户，与 RequestExecutionLevel user 对应）
  !define REG_UNINST "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}"
  WriteRegStr   HKCU "${REG_UNINST}" "DisplayName"     "${APP_NAME}"
  WriteRegStr   HKCU "${REG_UNINST}" "DisplayVersion"  "${APP_VERSION}"
  WriteRegStr   HKCU "${REG_UNINST}" "Publisher"       "${APP_PUBLISHER}"
  WriteRegStr   HKCU "${REG_UNINST}" "DisplayIcon"     "$INSTDIR\${APP_EXE}"
  WriteRegStr   HKCU "${REG_UNINST}" "InstallLocation" "$INSTDIR"
  WriteRegStr   HKCU "${REG_UNINST}" "UninstallString" "$INSTDIR\${UNINSTALL_EXE}"
  WriteRegStr   HKCU "${REG_UNINST}" "URLInfoAbout"    "${APP_URL}"
  WriteRegDWORD HKCU "${REG_UNINST}" "NoModify" 1
  WriteRegDWORD HKCU "${REG_UNINST}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  WriteRegDWORD HKCU "${REG_UNINST}" "EstimatedSize" "$0"
SectionEnd

; =============================================================
Section "$(SECTION_UNINST)"
  ; 先结束正在运行的应用进程，否则 FFGui.exe 被占用会导致删除失败、目录残留
  nsExec::Exec "taskkill /F /IM ${APP_EXE} /T"
  Pop $0

  Delete "$DESKTOP\${APP_NAME}.lnk"
  RMDir /r "$SMPROGRAMS\${APP_NAME}"
  RMDir /r "$INSTDIR"
  ; 兜底：大包文件被杀毒软件短暂占用时，等待后重试一次
  IfFileExists "$INSTDIR" 0 uninst_done
    Sleep 2000
    RMDir /r "$INSTDIR"
  uninst_done:
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}"
SectionEnd
