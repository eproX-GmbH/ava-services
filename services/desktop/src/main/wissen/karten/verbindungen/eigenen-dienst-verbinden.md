---
id: eigenen-dienst-verbinden
titel: Einen eigenen Dienst ohne Vorlage verbinden
fragen:
  - wie verbinde ich einen dienst der nicht in der liste ist
  - eigenen mcp server hinzufügen
  - custom mcp server url eintragen
  - dienst mit api key im header verbinden
  - kann ich jedes beliebige tool anschließen
schlagworte: [mcp, mcp server, eigener dienst, adresse, url, streamable http, sse, bearer, token, kopfzeilen, basic auth, benutzername, passwort, client credentials, client secret, header, api key, zugangscode, oauth, tool]
aktionen:
  - { art: zugang_anfordern, label: "Zugang eingeben" }
  - { art: app_oeffnen, ziel: dienst_verbinden, label: "Weitere Dienste öffnen" }
gilt_fuer: [desktop]
stand: 2026-11-07
---
Jeden Dienst, der eine Schnittstelle für KI-Assistenten anbietet, kannst du selbst verbinden. Du brauchst vom Anbieter die Adresse dieser Schnittstelle (beginnt mit https://) und den Zugang. Nenn mir den Dienst und die Adresse, dann zeige ich dir hier im Chat eine sichere Eingabekarte dafür.

Oder du machst es selbst unter Einstellungen → Verbindungen → Weitere Dienste mit „Dienst verbinden“ und der Vorlage „Eigener Dienst“:
- Art des Dienstes: die erste Auswahl für Dienste mit einzelnen Funktionen, „Agent“ für einen fremden Agenten.
- Name und Adresse.
- Zugang: „Schlüssel oder Zugangscode“, „Eigene Kopfzeilen“ (bis zu vier benannte Felder), „Benutzername und Passwort“, „Client-ID und Client-Secret“ mit der Adresse für die Anmeldung, oder „Ohne Zugang“.

Nach „Verbinden“ siehst du, ob es geklappt hat und wie viele Funktionen ich nutzen kann. Dienste, bei denen du dich nur in einem Anmeldefenster im Browser anmelden kannst, lassen sich so noch nicht verbinden.
