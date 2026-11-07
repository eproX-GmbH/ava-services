---
id: ki-lokale-ki-reparieren
titel: Lokale KI hängt oder ein lokales Modell stürzt ab
fragen:
  - ollama hängt
  - internal server error im chat mit lokalem modell
  - ollama neu starten
  - lokales modell reparieren
  - warte auf das lokale modell
  - lokales modell löschen speicherplatz
schlagworte: [ollama, lokal, neu starten, restart, reparieren, absturz, internal server error, hängt, löschen, speicherplatz, pflichtmodell, embeddinggemma, version]
aktionen:
  - { art: chat_vorschlag, ziel: "Starte die lokale KI neu.", label: "Lokale KI neu starten" }
  - { art: chat_vorschlag, ziel: "Zeig mir den Stand der lokalen KI und welche Modelle installiert sind.", label: "Lokale KI prüfen" }
  - { art: app_oeffnen, ziel: lokale_modelle, label: "Lokale KI öffnen" }
gilt_fuer: [desktop]
stand: 2026-11-07
---
Hängt der Chat mit einem lokalen Modell, etwa mit „Internal Server Error“, starte ich die lokale KI für dich neu. Das geht auch selbst: Einstellungen → KI & Kosten → Anbieter & Modell → „Lokal installierte Modelle (Ollama)“ → „Laufzeit neu starten“.

Bringt ein Modell die lokale KI immer wieder zum Absturz, klick dort beim Modell auf „reparieren“. Es wird gelöscht und frisch heruntergeladen, das hilft nach einem abgebrochenen Download. Mit „löschen“ gibst du Speicherplatz frei. Das Modell „embeddinggemma“ ist ein Pflichtmodell für die Ähnlichkeitssuche und lässt sich nicht entfernen.

Unter „Lokale KI“ siehst du, welche Version läuft und welche AVA vorsieht. Der Abgleich läuft beim Start von selbst. Passt etwas nicht, bringt „Neu installieren“ die vorgesehene Version zurück.
