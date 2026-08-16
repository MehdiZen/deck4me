; Enregistrement du filtre DirectShow de la caméra virtuelle pendant
; l'installation. L'installeur tourne en perMachine (donc élevé) : aucune
; demande UAC supplémentaire, l'utilisateur n'a rien à faire.
;
; /s = silencieux. On n'échoue pas l'installation si regsvr32 rate : l'app
; reste utilisable sans caméra virtuelle, et Réglages propose un bouton
; d'installation manuelle en secours.

!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "Enregistrement de la caméra virtuelle deck4me..."
  ExecWait '"$SYSDIR\regsvr32.exe" /s "$INSTDIR\softcam.dll"' $0
  ${If} $0 != 0
    DetailPrint "Caméra virtuelle non enregistrée (code $0) — installable depuis Réglages."
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DetailPrint "Retrait de la caméra virtuelle deck4me..."
  ExecWait '"$SYSDIR\regsvr32.exe" /u /s "$INSTDIR\softcam.dll"' $0
!macroend
