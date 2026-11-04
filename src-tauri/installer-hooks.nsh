; Asks during setup whether the app starts with Windows. A silent install changes nothing.

!define AUTOSTART_KEY "Software\Microsoft\Windows\CurrentVersion\Run"
!define AUTOSTART_VALUE "Pleasant Tray"

!macro NSIS_HOOK_POSTINSTALL
  IfSilent autostart_done
  MessageBox MB_YESNO|MB_ICONQUESTION "Soll Pleasant Tray beim Windows-Start automatisch im Infobereich mitstarten?" IDYES autostart_on
  DeleteRegValue HKCU "${AUTOSTART_KEY}" "${AUTOSTART_VALUE}"
  Goto autostart_done
  autostart_on:
  WriteRegStr HKCU "${AUTOSTART_KEY}" "${AUTOSTART_VALUE}" '"$INSTDIR\${MAINBINARYNAME}.exe" --autostart'
  autostart_done:
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegValue HKCU "${AUTOSTART_KEY}" "${AUTOSTART_VALUE}"
!macroend
