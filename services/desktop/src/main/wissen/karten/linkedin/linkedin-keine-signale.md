---
id: linkedin-keine-signale
titel: Der LinkedIn-Beobachter findet keine Signale, was kann ich prüfen?
fragen:
  - warum kommen keine linkedin signale
  - linkedin zeigt 0 beiträge
  - signale seite ist leer
  - linkedin auswertung übersprungen
  - beobachter tut nichts
schlagworte: [linkedin, keine signale, leer, 0 beiträge, übersprungen, ki-modell, fehler, letzte läufe, screenshots, sitzung, diagnose]
aktionen:
  - { art: chat_vorschlag, ziel: "Prüf, warum der LinkedIn-Beobachter keine Signale liefert", label: "Status prüfen" }
  - { art: app_oeffnen, ziel: linkedin_verbinden, label: "LinkedIn-Einstellungen" }
gilt_fuer: [desktop]
stand: 2026-11-07
---
Ich schaue mir gern den Stand an: ob LinkedIn verbunden ist und ob der Beobachter an ist. Die häufigsten Ursachen:

- Der Beobachter ist aus oder die Sitzung ist abgelaufen. Dann steht oben in der App ein Hinweis, die Seite „Signale“ bietet „Beobachter aktivieren“ an.
- „Automatisch im Hintergrund durchlaufen“ ist aus. Dann lese ich nur, wenn du „Jetzt durchlaufen“ klickst.
- Es ist kein KI-Modell bereit. Unter „Erfasste Daten“ stehen die Beiträge dann als „übersprungen (ohne KI-Modell)“.
- Ein Durchlauf hat 0 Beiträge gesehen. Unter „Letzte Läufe“ öffnest du mit „Ordner öffnen“ die Bildschirmfotos des Laufs und siehst, was LinkedIn gezeigt hat.

Alles findest du unter Einstellungen → Verbindungen → LinkedIn. Signale entstehen außerdem nur, wenn dein Feed Beiträge mit Bezug zu Firmen enthält.
