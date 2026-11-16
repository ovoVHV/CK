; Keep the remembered installer language as the default, not as a reason to
; skip the chooser on reinstall/update. NSIS still suppresses it for /S.
!define MUI_LANGDLL_ALWAYSSHOW

; Tauri includes FileAssociation.nsh immediately before this hook. Replace
; only its two association helpers so CK keeps the original extension owner
; across updates and cleans up its own values on uninstall.
; The shared CK Project ProgID is intentionally retained in this phase.

!ifmacrodef APP_ASSOCIATE
  !macroundef APP_ASSOCIATE
!endif

!macro APP_ASSOCIATE EXT FILECLASS DESCRIPTION ICON COMMANDTEXT COMMAND
  ; Save the original owner once. An existing (possibly empty) backup is
  ; authoritative and must never be overwritten by an update/reinstall.
  StrCpy $R0 ""
  StrCpy $R1 ""
  ClearErrors
  ReadRegStr $R0 SHELL_CONTEXT "Software\Classes\.${EXT}" "${FILECLASS}_backup"
  ${If} ${Errors}
    ReadRegStr $R1 SHELL_CONTEXT "Software\Classes\.${EXT}" ""
    ${If} "$R1" != "${FILECLASS}"
      WriteRegStr SHELL_CONTEXT "Software\Classes\.${EXT}" "${FILECLASS}_backup" "$R1"
    ${EndIf}
  ${EndIf}

  WriteRegStr SHELL_CONTEXT "Software\Classes\.${EXT}" "" "${FILECLASS}"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${FILECLASS}" "" `${DESCRIPTION}`
  WriteRegStr SHELL_CONTEXT "Software\Classes\${FILECLASS}\DefaultIcon" "" `${ICON}`
  WriteRegStr SHELL_CONTEXT "Software\Classes\${FILECLASS}\shell" "" "open"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${FILECLASS}\shell\open" "" `${COMMANDTEXT}`
  ; Keep both the executable path and the incoming file path quoted.
  WriteRegStr SHELL_CONTEXT "Software\Classes\${FILECLASS}\shell\open\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
!macroend

!ifmacrodef APP_UNASSOCIATE
  !macroundef APP_UNASSOCIATE
!endif

!macro APP_UNASSOCIATE EXT FILECLASS
  ; Restore only while CK still owns the extension. If another application
  ; took over after CK was installed, never overwrite that newer owner.
  StrCpy $R0 ""
  StrCpy $R1 ""
  ClearErrors
  ReadRegStr $R0 SHELL_CONTEXT "Software\Classes\.${EXT}" ""
  ${If} "$R0" == "${FILECLASS}"
    ClearErrors
    ReadRegStr $R1 SHELL_CONTEXT "Software\Classes\.${EXT}" "${FILECLASS}_backup"
    ${If} ${Errors}
      DeleteRegValue SHELL_CONTEXT "Software\Classes\.${EXT}" ""
    ${ElseIf} "$R1" == ""
      DeleteRegValue SHELL_CONTEXT "Software\Classes\.${EXT}" ""
    ${ElseIf} "$R1" == "${FILECLASS}"
      DeleteRegValue SHELL_CONTEXT "Software\Classes\.${EXT}" ""
    ${Else}
      WriteRegStr SHELL_CONTEXT "Software\Classes\.${EXT}" "" "$R1"
    ${EndIf}
  ${EndIf}

  ; The backup is CK metadata, regardless of whether it was restored.
  DeleteRegValue SHELL_CONTEXT "Software\Classes\.${EXT}" "${FILECLASS}_backup"
  DeleteRegKey /ifempty SHELL_CONTEXT "Software\Classes\.${EXT}"

  ; CK Project is shared by .ck and .maker. Remove the class only after both
  ; extensions no longer point at it.
  StrCpy $R2 ""
  StrCpy $R3 ""
  ReadRegStr $R2 SHELL_CONTEXT "Software\Classes\.ck" ""
  ReadRegStr $R3 SHELL_CONTEXT "Software\Classes\.maker" ""
  ${If} "$R2" != "${FILECLASS}"
    ${If} "$R3" != "${FILECLASS}"
      DeleteRegKey SHELL_CONTEXT "Software\Classes\${FILECLASS}"
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro UPDATEFILEASSOC
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  !insertmacro UPDATEFILEASSOC
!macroend
