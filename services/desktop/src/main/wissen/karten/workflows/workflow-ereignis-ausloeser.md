---
id: workflow-ereignis-ausloeser
titel: Einen Workflow automatisch bei einem Ereignis starten
fragen:
  - workflow starten wenn eine neue mail kommt
  - bei neuem radar treffer automatisch etwas machen
  - nach dem import automatisch eine hubspot notiz
  - trigger on event
  - workflow bei neuer meldung auslösen
  - wenn ein neuer linkedin lead kommt
schlagworte: [workflow, ereignis, event, trigger, auslöser, radar, mail, eingang, meldung, import, linkedin, lead, dienst, compleadly, webhook]
aktionen:
  - { art: chat_vorschlag, ziel: "Bau mir einen Workflow, der bei jedem neuen heißen Radar-Treffer ein Kurzprofil per Telegram schickt.", label: "Ereignis-Workflow bauen" }
  - { art: app_oeffnen, ziel: workflows, label: "Workflows öffnen" }
stand: 2026-11-07
---
Ein Workflow kann von selbst starten, sobald etwas passiert. Zur Wahl stehen:

- Radar: neuer heißer Treffer
- Mail: eingehende Nachricht
- Neue Meldung (auch nur bestimmte Arten, etwa neue Publikationen)
- Import abgeschlossen
- LinkedIn: neuer Lead
- Verbundener Dienst meldet etwas (zum Beispiel eine Antwort in CompLeadly)

Jedes Ereignis startet genau einen Lauf, doppelt läuft nichts. Meldungen, die Workflows selbst erzeugen, lösen nie einen Workflow aus. Sag mir, worauf ich reagieren soll und was dann passieren soll, oder stell es im Editor im Reiter „Trigger“ unter Art „Ereignis“ ein.

Gut zu wissen: Ereignisse kommen nur an, solange AVA läuft. Mail, Telegram und LinkedIn-Ereignisse gibt es nur, wenn du diese Verbindungen eingerichtet hast und deine Organisation sie freigeschaltet hat.
