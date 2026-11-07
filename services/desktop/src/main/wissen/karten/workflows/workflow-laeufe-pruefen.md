---
id: workflow-laeufe-pruefen
titel: Sehen, was ein Workflow-Lauf gemacht hat und warum er fehlschlug
fragen:
  - ist mein workflow gelaufen
  - warum ist der workflow fehlgeschlagen
  - workflow historie ansehen
  - lauf wiederholen
  - laufenden workflow abbrechen
  - workflow runs log
schlagworte: [workflow, lauf, läufe, historie, protokoll, fehler, fehlgeschlagen, wiederholen, abbrechen, status, ergebnis, runs]
aktionen:
  - { art: chat_vorschlag, ziel: "Wie sind meine Workflows zuletzt gelaufen?", label: "Letzte Läufe" }
  - { art: app_oeffnen, ziel: workflows, label: "Workflows öffnen" }
stand: 2026-11-07
---
Ich kann dir sagen, wann ein Workflow zuletzt lief, wie es ausging und an welchem Schritt es gehakt hat. Frag einfach.

Selbst nachsehen: Unter Vorgänge → Workflows → „Alle Läufe“ filterst du nach Status (erfolgreich, Fehler, läuft, wartet auf Vorgang, wartet auf Freigabe, abgebrochen), nach Workflow und Zeitraum. Im Editor zeigt der Reiter „Läufe“ jeden Lauf mit Firma, Dauer und dem Ergebnis je Schritt, inklusive Eingabe, Ausgabe und befüllter Platzhalter. Dort gibt es auch „Lauf abbrechen“ und „Lauf wiederholen“, das startet denselben Lauf mit denselben Eingaben neu. Wurde der Workflow inzwischen geändert, siehst du beim alten Lauf den damaligen Stand.

Nach jedem beendeten Lauf bekommst du eine Meldung, Fehler ebenfalls. Wird dir das zu viel, schalte ich die Meldung je Lauf für diesen Workflow ab.
