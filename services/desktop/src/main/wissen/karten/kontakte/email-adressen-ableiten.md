---
id: email-adressen-ableiten
titel: Wie AVA fehlende E-Mail-Adressen bildet und prüft
fragen:
  - woher kommt die email adresse
  - kannst du die email von herrn x herausfinden
  - email adressen ableiten
  - wie prüfst du ob eine mail adresse existiert
  - schickt ava dabei mails raus
  - welches email muster hat die firma
schlagworte: [email, e-mail-adressen, ableitung, adressmuster, muster, smtp, mail-server, verifizierung, verifizierungsrate, rcpt to, zuordnung]
aktionen:
  - { art: chat_vorschlag, ziel: "Welches E-Mail-Muster erkennst du bei dieser Firma?", label: "Muster ansehen" }
  - { art: chat_vorschlag, ziel: "Zeig mir die Einstellungen der E-Mail-Ableitung.", label: "Einstellungen zeigen" }
  - { art: app_oeffnen, ziel: email_adressen, label: "E-Mail-Adressen öffnen" }
gilt_fuer: [alle]
stand: 2026-11-07
---
Fehlt einem Kontakt die E-Mail-Adresse, leite ich sie aus dem Muster der Firma ab, etwa vorname.nachname@firma.de. Das Muster lerne ich aus bekannten persönlichen Adressen derselben Firma. Firmenadressen mit Namen wie pdettlev@ ordne ich der passenden Person zu. Funktionsadressen wie info@ nehme ich nie als persönliche Adresse und lerne aus ihnen kein Muster. Gebildete Adressen nenne ich so lange „nicht bestätigt“, bis eine Prüfung sie bestätigt. Das passiert direkt nach dem Kontaktlauf jeder Firma.

Jede gebildete Adresse frage ich einzeln beim Mail-Server der Firma ab, ohne eine E-Mail zu senden. Eine eingehende Antwort bestätigt eine Adresse, eine Unzustellbarkeitsmeldung entfernt sie wieder. Für eine Firma zeige ich dir auf Wunsch vorab, welches Muster ich erkenne und welche Adressen ich bilden würde.

In der Desktop-App liegen die Schalter unter Einstellungen → Recherche → E-Mail-Adressen: Ableitung an oder aus, Firmenadressen Personen zuordnen, unverifizierte Ableitungen anzeigen und die Verifizierungsrate, standardmäßig 300 Anfragen je Stunde. Höher ist schneller, belastet aber fremde Mail-Server stärker. Umstellen kann ich das auch hier.
