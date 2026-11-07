---
id: workflow-freigaben
titel: Freigaben für Workflow-Schritte erteilen (App, Meldungen, Telegram)
fragen:
  - workflow wartet auf freigabe
  - wie gebe ich einen schritt frei
  - freigabe per telegram
  - workflow hängt bei freigabe
  - approve workflow step
  - was heißt freigabe offen
schlagworte: [workflow, freigabe, freigaben, approval, human in the loop, genehmigen, ablehnen, telegram, mail, obergrenze, vollmacht, schreibend]
aktionen:
  - { art: chat_vorschlag, ziel: "Zeig mir die offenen Workflow-Freigaben.", label: "Offene Freigaben zeigen" }
  - { art: app_oeffnen, ziel: workflows, label: "Workflows öffnen" }
stand: 2026-11-07
---
Schritte, die etwas verändern, etwa CRM-Einträge, Importe oder Mails, laufen unbeaufsichtigt nur, wenn du sie freigegeben hast. Das ist ein Haken am Schritt im Editor. Mails gehen nur mit dieser Freigabe oder mit einem Freigabe-Schritt davor raus. Ein Freigabe-Schritt hält den Lauf an, bis du entscheidest.

Offene Freigaben siehst du an drei Stellen: oben auf der Seite Workflows mit „Freigeben“ und „Ablehnen“, als Meldung und auf Telegram. Dort schreibst du /freigaben für die Liste und dann /ja oder /nein mit der Kennung. Ich kann dir die offenen Freigaben auch hier zeigen und für dich entscheiden, wenn du es sagst.

Ohne Entscheidung verfällt eine Freigabe nach 48 Stunden, der Lauf bricht dann ab. Für Mails gilt zusätzlich eine Obergrenze je Workflow und Tag, standardmäßig 20. Ist sie erreicht, bricht der Lauf ab und weitere Mails gehen erst am nächsten Tag raus. Die Grenze kann ich dir ändern.
