---
id: ki-diktat
titel: Nachrichten diktieren statt tippen (Spracheingabe)
fragen:
  - kann ich diktieren
  - mikrofon im chat geht nicht
  - spracherkennung einrichten
  - sprachmodell herunterladen
  - whisper installieren
  - speech to text
schlagworte: [diktat, diktieren, spracheingabe, spracherkennung, mikrofon, whisper, sprachmodell, lokal, transkription, speech to text]
aktionen:
  - { art: chat_vorschlag, ziel: "Richte die Spracherkennung für das Diktat ein.", label: "Spracherkennung einrichten" }
  - { art: app_oeffnen, ziel: spracherkennung, label: "Spracherkennung öffnen" }
gilt_fuer: [desktop]
stand: 2026-11-07
---
Mit dem Mikrofon-Knopf im Chat diktierst du deine Nachricht, sie erscheint als Text im Eingabefeld und du kannst sie vor dem Senden noch ändern. Beenden geht mit „Diktat beenden“ oder Cmd+D (Windows Ctrl+D), Esc bricht ab. Die Erkennung läuft lokal auf deinem Rechner, die Aufnahme verlässt das Gerät nicht.

Dafür braucht es einmal das lokale Sprachmodell, einige hundert MB. Ich kann es dir einrichten: Status prüfen, die Spracherkennung installieren und das Modell herunterladen. Selbst geht es unter Einstellungen → KI & Kosten → Spracherkennung → „Sprachmodell herunterladen“. Solange es fehlt, ist der Mikrofon-Knopf ausgegraut und führt dich per Klick dorthin.

Mit „Sprachmodell entfernen“ gibst du den Speicher wieder frei. Das lokale Modell braucht auch das Aktivierungswort „Hey AVA“ im Sprachmodus.
