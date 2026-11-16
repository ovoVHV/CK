export const storageIncludes = String.raw`
!include "nsDialogs.nsh"
!include "FileFunc.nsh"
Var DataRoot
Var DataDialog
Var DataEdit
Var DataBrowse
Var ExistingData
Var LastDefaultDataRoot
`;
export const storageInit = String.raw`
  StrCpy $ExistingData 0
  IfFileExists "$LOCALAPPDATA\CKBuildEngineV91\storage.json" hasData
  IfFileExists "$LOCALAPPDATA\CKBuildEngineV91\environment.json" hasData noData
  hasData:
    StrCpy $ExistingData 1
  noData:
`;
export const storagePage = 'Page custom CKDataPage CKDataPageLeave';
export const storageFunctions = String.raw`
Function CKDataDefault
  @{GetParent} "$INSTDIR" $0
  StrCpy $0 "$0\CKData"
  StrCmp $DataRoot "" useDefaultData
  StrCmp $DataRoot $LastDefaultDataRoot useDefaultData dataRootReady
  useDefaultData:
    StrCpy $DataRoot $0
  dataRootReady:
  StrCpy $LastDefaultDataRoot $0
FunctionEnd
Function CKDataPage
  StrCmp $ExistingData 1 0 showDataPage
    Abort
  showDataPage:
  Call CKDataDefault
  !insertmacro MUI_HEADER_TEXT "数据保存位置" "核心包、工具链、编译缓存和下载文件将保存在这里。"
  nsDialogs::Create 1018
  Pop $DataDialog
  @{NSD_CreateLabel} 0 0 100% 38u "默认与程序安装在同一个盘。请选择专用空文件夹；程序升级和卸载会保留这些数据。已有用户的数据位置保持不变，可安装后在主页设置中迁移。"
  Pop $0
  @{NSD_CreateDirRequest} 0 48u 80% 14u "$DataRoot"
  Pop $DataEdit
  @{NSD_CreateBrowseButton} 82% 47u 18% 16u "浏览..."
  Pop $DataBrowse
  @{NSD_OnClick} $DataBrowse CKDataBrowse
  nsDialogs::Show
FunctionEnd
Function CKDataBrowse
  nsDialogs::SelectFolderDialog "选择数据目录" "$DataRoot"
  Pop $0
  StrCmp $0 error doneBrowse
    @{NSD_SetText} $DataEdit "$0"
  doneBrowse:
FunctionEnd
Function CKDataPageLeave
  @{NSD_GetText} $DataEdit $DataRoot
  StrCmp $DataRoot "" 0 dataSelected
    MessageBox MB_OK "请选择数据保存位置。"
    Abort
  dataSelected:
FunctionEnd
` .replaceAll('@{', '${');
export const storageInstall = String.raw`
  StrCmp $DataRoot "" 0 initializeData
    @{GetParent} "$INSTDIR" $DataRoot
    StrCpy $DataRoot "$DataRoot\CKData"
  initializeData:
  nsExec::ExecToStack '"$INSTDIR\engine\runtime\node.exe" "$INSTDIR\engine\scripts\storage-cli.mjs" init "$INSTDIR" "$DataRoot"'
  Pop $0
  Pop $1
  StrCmp $0 0 dataInitialized
    MessageBox MB_OK "数据目录初始化失败，原数据未改变：$\r$\n$1"
    SetErrorLevel 1
    Abort
  dataInitialized:
`.replaceAll('@{', '${');
