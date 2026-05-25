; v0.1.308 — Custom NSIS-Include für den Windows-Installer.
;
; Vor dem Entpacken / Schreiben der Dateien forcieren wir die
; Beendigung aller AVA-Prozesse (inkl. Subprocesses: 6 Producer +
; Ollama). Sonst halten Children weiter Datei-Handles auf
; AVA.exe / Uninstall AVA.exe und der Installer schlägt fehl mit
; "Fehler beim Schreiben der Datei …" (Real-Run-Bug).
;
; /F = force, /T = process tree. /IM matcht alle Instanzen.
; 2>NUL unterdrückt "Prozess nicht gefunden"-Meldungen wenn nichts
; läuft (Fresh-Install).

!macro customInit
  nsExec::Exec 'taskkill /F /T /IM "AVA.exe"'
  nsExec::Exec 'taskkill /F /T /IM "ollama.exe"'
  ; Kurze Pause damit Windows die File-Handles wirklich freigibt
  Sleep 500
!macroend

!macro customUnInit
  nsExec::Exec 'taskkill /F /T /IM "AVA.exe"'
  nsExec::Exec 'taskkill /F /T /IM "ollama.exe"'
  Sleep 500
!macroend
