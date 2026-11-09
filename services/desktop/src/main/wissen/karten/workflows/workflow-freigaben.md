---
id: workflow-freigaben
titel: Freigaben für Workflow-Schritte erteilen (App, Meldungen, Telegram)
fragen:
  - workflow wartet auf freigabe
  - wie gebe ich einen schritt frei
  - freigabe per telegram
  - workflow hängt bei freigabe
  - mein workflow wartet, wie geht er weiter
  - approve workflow step
  - was heißt freigabe offen
  - workflow soll ohne rückfrage selbstständig laufen
  - muss ich bei jedem kontakt einzeln freigeben
  - workflow darf auch löschen ohne nachfrage
  - workflow bricht ab item-grenze
schlagworte: [workflow, freigabe, freigaben, approval, human in the loop, genehmigen, ablehnen, telegram, mail, obergrenze, vollmacht, schreibend, selbstständig, autonom, ohne rückfrage, jeder kontakt, löschen, item-grenze, läuft selbstständig]
aktionen:
  - { art: chat_vorschlag, ziel: "Zeig mir die offenen Workflow-Freigaben.", label: "Offene Freigaben zeigen" }
  - { art: app_oeffnen, ziel: workflows, label: "Workflows öffnen" }
stand: 2026-11-09
---
Schritte, die etwas verändern, etwa CRM-Einträge, Importe, Mail-Entwürfe, Mails oder Löschungen, brauchen deine Freigabe. Lege ich dir einen Workflow an, frage ich dich dabei einmal, ob er selbstständig laufen soll. Sagst du ja, führt er künftig alle Schritte allein aus: ohne Rückfrage, auch löschende Schritte und Mail-Versand, und ohne Obergrenze für Einträge oder Mails. Im Editor ist das der Haken „Läuft selbstständig“ in den Einstellungen des Workflows. Ich kann es dir auch jederzeit umstellen („lass den Workflow selbstständig laufen“ oder „frag wieder vorher“).

Läuft ein Workflow nicht selbstständig, fragt jeder verändernde Schritt in jedem Lauf einmal nach, bevor er loslegt. Diese eine Freigabe gilt dann für alle Einträge des Laufs, etwa für alle 50 Entwürfe, nicht für jeden einzeln. Einzelne Schritte kannst du im Editor mit „Für unbeaufsichtigte Läufe freigegeben“ dauerhaft freigeben. Was du im Chat mit „Immer erlauben“ freigegeben hast, fragt auch im Workflow nicht mehr. Welche Workflows selbstständig laufen, siehst du auch unter Einstellungen → Konto → Erlaubnisse. Ein Freigabe-Schritt hält den Lauf an, bis du entscheidest.

Offene Freigaben siehst du an drei Stellen: oben auf der Seite Workflows mit „Freigeben“ und „Ablehnen“, als Meldung und auf Telegram. Dort schreibst du /freigaben für die Liste und dann /ja oder /nein mit der Kennung. Ich kann dir die offenen Freigaben auch hier zeigen und für dich entscheiden, wenn du es sagst.

Ohne Entscheidung verfällt eine Freigabe nach 48 Stunden, der Lauf bricht dann ab. Nur bei Workflows, die nicht selbstständig laufen, gibt es Obergrenzen: höchstens 500 Einträge je Lauf und 20 Mails je Tag. Ist eine erreicht, bricht der Lauf ab. Beide Grenzen kann ich dir ändern, oder du lässt den Workflow selbstständig laufen.
