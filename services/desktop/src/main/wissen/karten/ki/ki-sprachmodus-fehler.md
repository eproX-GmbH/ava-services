---
id: ki-sprachmodus-fehler
titel: Sprachmodus startet nicht oder bricht ab
fragen:
  - sprachmodus geht nicht
  - zugriff auf das mikrofon wurde verweigert
  - keine verbindung zu openai im sprachmodus
  - der openai-schlüssel wurde abgelehnt
  - wellen knopf fehlt im chat
schlagworte: [sprachmodus, fehler, mikrofon, verweigert, kein mikrofon, verbindung, webrtc, proxy, firewall, schlüssel, kontingent, erneut verbinden]
aktionen:
  - { art: app_oeffnen, ziel: modell, label: "OpenAI-Schlüssel prüfen" }
  - { art: app_oeffnen, ziel: sprachmodus, label: "Sprachmodus öffnen" }
gilt_fuer: [desktop]
stand: 2026-11-07
---
Die häufigsten Gründe und was hilft:
- „Der Zugriff auf das Mikrofon wurde verweigert“: Erlaube AVA das Mikrofon in den Systemeinstellungen (Knopf „Mikrofon-Einstellungen öffnen“), dann „Erneut verbinden“.
- „Kein Mikrofon gefunden“: Schließ ein Mikrofon an oder wähle eines in den Systemeinstellungen.
- „Keine Verbindung zu OpenAI“: Prüfe das Internet. Hinter einem Firmen-Proxy oder einer Firewall wird die Sprachverbindung oft blockiert, dann hilft ein anderes Netz.
- „Der OpenAI-Schlüssel wurde abgelehnt“: Trag deinen Schlüssel unter KI & Kosten → Anbieter & Modell neu ein. Läuft es über die Organisation, muss ein Admin ihn erneuern.
- „Kontingent bei OpenAI erschöpft“: Guthaben nachladen oder warten, bis das Limit zurückgesetzt ist.

Fehlt der Wellen-Knopf im Chat, ist der Sprachmodus aus, es fehlt ein OpenAI-Schlüssel oder deine Organisation hat ihn abgeschaltet. Unter KI & Kosten → Mit AVA sprechen steht dann der Grund.
