---
id: workflow-mehrere-firmen
titel: Einen Workflow für mehrere Firmen auf einmal laufen lassen
fragen:
  - workflow für alle meine firmen starten
  - workflow für 20 firmen auf einmal
  - jede firma einzeln durchlaufen lassen
  - batch workflow
  - wie funktionieren platzhalter im workflow
schlagworte: [workflow, mehrere firmen, stapel, batch, je firma, platzhalter, kontext, firmenkontext, unter-workflow, subworkflow, warten]
aktionen:
  - { art: chat_vorschlag, ziel: "Starte meinen Workflow für alle Firmen aus meinem letzten Import.", label: "Für mehrere Firmen starten" }
  - { art: app_oeffnen, ziel: workflows, label: "Workflows öffnen" }
stand: 2026-11-07
---
Jeder Lauf gilt für genau eine Firma und kennt sie vollständig: Stammdaten, Profil, Finanzen, Kontakte und den CRM-Stand. Deshalb können Schritte Platzhalter in Alltagssprache nutzen, etwa den Kassenbestand oder den Ansprechpartner im Vertrieb. Ich fülle sie aus dem Kontext und setze einen Ersatztext, wenn ein Wert fehlt.

Für mehrere Firmen starte ich je Firma einen eigenen Lauf, bis zu drei gleichzeitig und höchstens 200 auf einmal. Nenn mir die Firmen oder sag zum Beispiel „für alle Firmen aus dem letzten Import“. In der App wählst du beim Start mehrere Firmen aus. Für regelmäßige Läufe gibt es im Zeitplan die Firmenquelle.

Ein Workflow kann außerdem warten, bis eine frisch aufgenommene Firma fertig verarbeitet ist, und erst dann weitermachen. Oder ein übergeordneter Workflow sammelt Firmen, etwa aus dem Radar, und startet je Firma einen Unter-Workflow.
