; Mymux NSIS installer hooks (wired via tauri.conf.json > bundle > windows > nsis > installerHooks).
;
; Every open terminal session runs an OpenConsole.exe (the sideloaded ConPTY
; host) straight from the install dir. The installer closes Mymux.exe but not
; these children, so overwriting OpenConsole.exe fails with "Error opening
; file for writing" (Abort/Retry). A running exe cannot be overwritten but it
; CAN be renamed, so we move the locked binaries aside and let the installer
; write fresh copies. Unique names avoid colliding with a copy still running
; from an even earlier update; stale *.conpty-old files are swept on the next
; install (and best-effort after this one).

!macro NSIS_HOOK_PREINSTALL
  Delete "$INSTDIR\*.conpty-old"
  ${If} ${FileExists} "$INSTDIR\OpenConsole.exe"
    GetTempFileName $0 "$INSTDIR"
    Delete "$0"
    Rename "$INSTDIR\OpenConsole.exe" "$0.conpty-old"
  ${EndIf}
  ${If} ${FileExists} "$INSTDIR\conpty.dll"
    GetTempFileName $0 "$INSTDIR"
    Delete "$0"
    Rename "$INSTDIR\conpty.dll" "$0.conpty-old"
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  Delete /REBOOTOK "$INSTDIR\*.conpty-old"
!macroend
