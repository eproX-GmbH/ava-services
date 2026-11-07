---
id: workflow-testen
titel: Einen Workflow gefahrlos testen (Trockenlauf)
fragen:
  - workflow testen ohne dass etwas passiert
  - was ist ein trockenlauf
  - dry run workflow
  - nur bis zu einem schritt testen
  - workflow ausprobieren mit einer firma
schlagworte: [workflow, test, testen, trockenlauf, dry run, vorschau, pin, ausgabe pinnen, bis hierhin testen, kosten]
aktionen:
  - { art: chat_vorschlag, ziel: "Mach einen Trockenlauf meines Workflows mit einer meiner Firmen.", label: "Trockenlauf starten" }
  - { art: app_oeffnen, ziel: workflows, label: "Workflows öffnen" }
stand: 2026-11-07
---
Beim Trockenlauf laufen alle lesenden Schritte echt, schreibende Schritte wie CRM-Einträge, Mails oder Importe zeige ich nur als Vorschau. Es wird also nichts verändert. Sag mir einfach „mach einen Trockenlauf mit Firma X“, dann zeige ich dir das Ergebnis je Schritt und welche Platzhalter ich wie gefüllt habe.

In der App geht es über den Knopf „Trockenlauf“ auf der Workflow-Karte. Im Editor klickst du einen Schritt an und wählst „Bis hierhin testen“, dann läuft der Test nur bis einschließlich dieses Schritts. Mit „Ausgabe pinnen“ merkst du dir das Ergebnis eines Schritts, und spätere Tests nutzen es, statt den Schritt erneut auszuführen. Das spart Zeit und Kosten.

Oben im Editor steht eine grobe Kostenübersicht je Lauf. Passt alles, startest du mit „Jetzt ausführen“ den echten Lauf; vorher frage ich noch einmal nach.
