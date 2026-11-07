---
id: compleadly-rueckmeldungen
titel: Rückmeldungen aus CompLeadly in AVA bekommen (Lead hat geantwortet)
fragen:
  - sagst du mir wenn ein lead in compleadly antwortet
  - compleadly webhook einrichten
  - rückkanal für compleadly
  - hat jemand auf meine linkedin nachricht geantwortet
  - compleadly antworten als notiz nach close
schlagworte: [compleadly, rückkanal, webhook, ereignisse, lead hat geantwortet, kontaktanfrage angenommen, benachrichtigung, close, notiz, aufgabe, premium]
aktionen:
  - { art: chat_vorschlag, ziel: "Was hat CompLeadly zuletzt an AVA gemeldet?", label: "Letzte Ereignisse zeigen" }
  - { art: app_oeffnen, ziel: dienst_verbinden, label: "Rückkanal einrichten" }
gilt_fuer: [desktop]
stand: 2026-11-07
---
CompLeadly kann mir melden, was in deinen Sequenzen passiert: Kontaktanfrage gesendet oder angenommen, Nachricht gesendet, Lead hat geantwortet. Dafür richtest du einmal den Rückkanal ein.

Unter Einstellungen → Verbindungen → Weitere Dienste klickst du an der Karte von CompLeadly bei „Rückkanal“ auf „Adresse anlegen“ und dann auf „Kopieren“. In CompLeadly trägst du die Adresse unter Einstellungen → Webhooks ein. Das gibt es bei CompLeadly ab dem Premium-Tarif.

Danach schaue ich alle drei Minuten nach neuen Ereignissen und melde sie dir als Benachrichtigung, etwa „CompLeadly: Lead hat geantwortet“ mit Name und Firma. Kenne ich die Person aus deinem Bestand, ordne ich das Ereignis über ihr LinkedIn-Profil zu. Mit der Workflow-Vorlage „CompLeadly-Rückmeldung als Notiz in Close“ schreibe ich daraus eine Notiz an den Lead in Close, bei einer Antwort zusätzlich eine Aufgabe zum Nachfassen.

Ohne Rückkanal frage ich den Stand bei Bedarf direkt in CompLeadly ab.
