---
id: workflow-zeitplan
titel: Einen Workflow regelmäßig nach Zeitplan laufen lassen
fragen:
  - workflow jeden morgen um 8 starten
  - zeitplan für workflow einstellen
  - workflow täglich ausführen lassen
  - schedule workflow every monday
  - kann der workflow automatisch laufen
  - workflow alle 60 minuten
schlagworte: [workflow, zeitplan, schedule, cron, täglich, wöchentlich, intervall, uhrzeit, wochentage, trigger, auslöser, firmenquelle, jeden freitag, bericht, automatisieren]
aktionen:
  - { art: chat_vorschlag, ziel: "Lass meinen Workflow jeden Werktag um 8 Uhr laufen.", label: "Zeitplan einstellen" }
  - { art: app_oeffnen, ziel: workflows, label: "Workflows öffnen" }
stand: 2026-11-07
---
Sag mir einfach, wann der Workflow laufen soll, zum Beispiel „jeden Werktag um 8 Uhr“ oder „alle 60 Minuten“, dann stelle ich den Auslöser um. Im Editor geht es selbst über den Reiter „Trigger“: Art „Zeitplan“, dann eine Uhrzeit mit Wochentagen oder ein Intervall in Minuten.

Arbeitet der Workflow mit Firmen, legst du die Firmenquelle fest: eine feste Liste, heiße Radar-Kandidaten ab einem Mindest-Score, alle Firmen eines Vorgangs oder alle deine Firmen. Für jede Firma startet ein eigener Lauf. Firmen, die im selben Zeitfenster schon dran waren, überspringe ich.

Wichtig: Ein Zeitplan greift nur, wenn AVA zu dieser Zeit läuft und der Workflow auf „aktiv“ steht. Versäumte Läufe hole ich nicht nach. Wann der nächste Lauf ansteht, siehst du auf der Workflow-Karte unter „Nächster Lauf“.
