---
id: telegram-antwortet-nicht
titel: Der Telegram-Bot antwortet nicht oder schickt nichts
fragen:
  - der telegram bot reagiert nicht
  - die testnachricht kommt nicht an
  - bei telegram steht chat fehlt noch
  - ich bekomme keine meldungen auf telegram
  - telegram geht nicht
  - seit ich abgemeldet bin antwortet telegram nicht mehr
schlagworte: [telegram, antwortet nicht, reagiert nicht, fehler, chat fehlt noch, chat verknüpfen, testnachricht, gegenrichtung, offline, abgemeldet, anmeldung, zweiter bot, gruppe]
aktionen:
  - { art: app_oeffnen, ziel: telegram_verbinden, label: "Telegram prüfen" }
stand: 2026-11-11
---
Geh die Punkte unter Einstellungen → Verbindungen → Telegram durch:

- Steht dort „Chat fehlt noch“, schick dem Bot „/start“ und klick „Chat verknüpfen“.
- Für Antworten muss „Auf meine Nachrichten antworten (Gegenrichtung)“ an sein, für Meldungen „Meldungen an Telegram senden“.
- Kommt die Testnachricht nicht an, steht dort der letzte Fehler, und wann zuletzt etwas zugestellt oder wegen Ruhezeit zurückgehalten wurde.
- Deine AVA muss laufen. Ist der Rechner aus, beantworte ich deine Nachrichten, sobald er wieder an ist.
- Du musst in AVA angemeldet sein. Bist du abgemeldet, nehme ich über Telegram nichts an; nach der Anmeldung geht es weiter.
- Hängt derselbe Bot an einer zweiten AVA, etwa auf einem Server, holt diese die Nachrichten ab. Dann braucht jede AVA einen eigenen Bot.

Ich schreibe nur in den verknüpften Chat. Nachrichten aus einem anderen Konto oder einer Gruppe verwerfe ich.
