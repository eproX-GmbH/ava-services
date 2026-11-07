---
id: ki-tageslimit
titel: Eine Tages-Obergrenze für den KI-Verbrauch setzen
fragen:
  - token limit pro tag setzen
  - kann ich den verbrauch begrenzen
  - tägliches token-limit aufgebraucht
  - limit entfernen
  - max 200000 tokens am tag
  - daily limit
schlagworte: [limit, tageslimit, obergrenze, token, tokens, textbausteine, verbrauch, kosten, begrenzen, pausiert, daily limit]
aktionen:
  - { art: chat_vorschlag, ziel: "Setz mir eine Tages-Obergrenze von 200.000 Textbausteinen.", label: "Obergrenze setzen" }
  - { art: app_oeffnen, ziel: verbrauch, label: "Verbrauch öffnen" }
  - { art: app_oeffnen, ziel: verbrauch_limit, label: "Tageslimit öffnen" }
gilt_fuer: [desktop]
stand: 2026-11-07
---
Du kannst festlegen, wie viel KI ich pro Tag höchstens verbrauche. Gezählt wird in Textbausteinen, so wie die Anbieter abrechnen. Sag mir einfach eine Zahl, etwa „höchstens 200.000 am Tag“, dann setze ich die Grenze. „Limit entfernen“ hebt sie wieder auf. Standard ist: keine Grenze.

Selbst geht es unter Einstellungen → KI & Kosten → Verbrauch → Tages-Obergrenze. Dort siehst du auch, wie viel heute schon verbraucht ist.

Ist die Grenze erreicht, wird die laufende Anfrage noch fertig, danach pausiere ich neue Anfragen. Oben in der App erscheint dann ein Hinweis mit „Limit anpassen“. Es geht weiter, sobald du die Grenze erhöhst oder entfernst. Diese Grenze betrifft nur die KI-Nutzung über deinen Zugang. Das Ausgabenlimit für Firmen in deinem Plan ist etwas anderes und steht unter Konto → Plan & Abrechnung.
