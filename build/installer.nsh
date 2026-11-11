; The app writes its command-line launchers here on first start; take them away again on uninstall.
!macro customUnInstall
  Delete "$LOCALAPPDATA\Microsoft\WindowsApps\quickmail.cmd"
  Delete "$LOCALAPPDATA\Microsoft\WindowsApps\qm.cmd"
!macroend
