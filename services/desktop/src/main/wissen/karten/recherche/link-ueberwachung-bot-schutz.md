---
id: link-ueberwachung-bot-schutz
titel: Die überwachte Seite lädt nicht oder zeigt eine Sicherheitsprüfung
fragen:
  - die link überwachung zeigt fehler
  - cloudflare prüfung bei der überwachung
  - seite lädt nicht bei der überwachung
  - timeout teilergebnis was heißt das
  - hat die seite wirklich geladen
  - captcha bei der überwachung
schlagworte: [link-überwachung, bot-schutz, cloudflare, captcha, sicherheitsprüfung, fehler, timeout, screenshot, bildschirmfoto, verlauf, intervall]
aktionen:
  - { art: chat_vorschlag, ziel: "Prüf meine Link-Überwachung jetzt und sag mir, ob die Seite geladen hat.", label: "Jetzt prüfen" }
gilt_fuer: [desktop]
stand: 2026-11-07
---
Viele Shops und Seiten haben einen Bot-Schutz, etwa die Sicherheitsprüfung von Cloudflare. Läuft sie, warte ich bis zu 25 Sekunden ab. Geht sie von selbst durch, prüfe ich normal weiter. Bleibt sie stehen, löse ich sie nicht und umgehe sie nicht; der Lauf zeigt dann nicht die Zielseite.

Sehr kurze Intervalle lösen den Schutz häufiger aus. Für Verfügbarkeit und Preise sind 30 bis 60 Minuten meist die verlässlichere Wahl. Steht „Timeout (Teilergebnis)“ in der Zeile, hat die Seite zu lange gebraucht.

Ob eine Seite wirklich geladen hat, zeigt das Bildschirmfoto, das ich bei jedem Lauf aufnehme. Du findest es unter Einstellungen → Erweitert → Verlauf beim jeweiligen Eintrag. Je Überwachung bewahre ich die letzten zehn auf.
