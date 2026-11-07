---
id: ki-modell-antwortet-nicht
titel: Die KI antwortet nicht, ist nicht bereit oder meldet einen Fehler
fragen:
  - ava antwortet nicht
  - authentifizierung fehlgeschlagen
  - modell ist nicht bereit
  - server überlastet fehler
  - das gewählte modell ist mit deinem konto nicht verfügbar
  - schlüssel ungültig
schlagworte: [fehler, antwortet nicht, nicht bereit, status, 401, schlüssel ungültig, authentifizierung, überlastet, 529, 503, modell nicht verfügbar, model not found]
aktionen:
  - { art: app_oeffnen, ziel: modell, label: "Anbieter & Modell prüfen" }
gilt_fuer: [desktop]
stand: 2026-11-07
---
Unter Einstellungen → KI & Kosten → Anbieter & Modell zeigt „Status“, ob dein Modell bereit ist, und nennt sonst den Grund. Die häufigsten Meldungen:

- „Authentifizierung fehlgeschlagen“: Der Schlüssel ist falsch, abgelaufen oder widerrufen. Trag ihn in der Karte des Anbieters neu ein.
- „Die KI-Server sind gerade kurzzeitig überlastet“: Ein Engpass beim Anbieter, nicht bei dir. Ich habe es schon mehrfach versucht, schick die Nachricht in ein paar Sekunden einfach noch einmal.
- „Das gewählte Modell ist mit deinem Konto nicht verfügbar“: Wähle ein anderes Modell desselben Anbieters.
- Mit lokalem Modell steht im Eingabefeld „Warte auf das lokale Modell…“: Die lokale KI startet noch oder hängt. Ich kann sie neu starten.

Bleibt es dabei, kann ich dich auf einen anderen Anbieter umstellen, für den du einen Zugang hast.
