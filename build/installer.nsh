; Makes Redline PDF appear in Settings -> Default apps.
;
; electron-builder's fileAssociations support writes the ProgID under
; Software\Classes and adds it to .pdf's OpenWithProgids. That is enough for
; the "Open with" dialog, but the Default apps UI does not read either of
; those — it enumerates HKCU\Software\RegisteredApplications and follows each
; entry to a Capabilities key. Without the four writes below the app installs
; correctly, associates correctly, and still cannot be found in the one place
; users actually go to set a default.
;
; The FileAssociations value must name the same ProgID electron-builder
; generated, which is the `name` field of the fileAssociations entry in
; package.json. If that changes, change it here too or this points at nothing.
;
; SHELL_CONTEXT resolves to HKCU for a per-user install (perMachine: false)
; and HKLM for a per-machine one, so this follows the installer either way.

!macro customInstall
  WriteRegStr SHELL_CONTEXT "Software\Redline PDF\Capabilities" \
    "ApplicationName" "Redline PDF"
  WriteRegStr SHELL_CONTEXT "Software\Redline PDF\Capabilities" \
    "ApplicationDescription" "Fast PDF markup tool for electrical drawings"
  WriteRegStr SHELL_CONTEXT "Software\Redline PDF\Capabilities" \
    "ApplicationIcon" "$INSTDIR\Redline PDF.exe,0"
  WriteRegStr SHELL_CONTEXT "Software\Redline PDF\Capabilities\FileAssociations" \
    ".pdf" "RedlinePDF.Document"
  WriteRegStr SHELL_CONTEXT "Software\RegisteredApplications" \
    "Redline PDF" "Software\Redline PDF\Capabilities"
!macroend

!macro customUnInstall
  DeleteRegKey SHELL_CONTEXT "Software\Redline PDF"
  DeleteRegValue SHELL_CONTEXT "Software\RegisteredApplications" "Redline PDF"
!macroend
