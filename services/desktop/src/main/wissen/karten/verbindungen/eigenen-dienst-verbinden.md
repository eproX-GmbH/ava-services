---
id: eigenen-dienst-verbinden
titel: Einen eigenen Dienst ohne Vorlage verbinden
fragen:
  - wie verbinde ich einen dienst der nicht in der liste ist
  - eigenen mcp server hinzufügen
  - custom mcp server url eintragen
  - dienst mit api key im header verbinden
  - kann ich jedes beliebige tool anschließen
schlagworte: [mcp, mcp server, eigener dienst, adresse, url, streamable http, sse, bearer, token, kopfzeilen, header, api key, zugangscode, oauth, tool]
aktionen:
  - { art: app_oeffnen, ziel: dienst_verbinden, label: "Dienst verbinden" }
gilt_fuer: [desktop]
stand: 2026-11-07
---
Jeden Dienst, der eine Schnittstelle für KI-Assistenten anbietet, kannst du selbst verbinden. Du brauchst vom Anbieter die Adresse dieser Schnittstelle (beginnt mit https://) und den Zugang.

Unter Einstellungen → Verbindungen → Weitere Dienste klickst du auf „Dienst verbinden“, lässt die Vorlage auf „Eigener Dienst“ und füllst aus:
- Art des Dienstes: die erste Auswahl für Dienste mit einzelnen Funktionen, „Agent“ für einen fremden Agenten, der Aufträge in Textform annimmt.
- Name und Adresse.
- Zugang: „Zugangscode“, wenn der Anbieter dir einen Schlüssel gibt, „Eigene Kopfzeilen“, wenn er bestimmte Felder mit Namen verlangt (bis zu vier), oder „Ohne Zugang“.

Nach „Verbinden“ zeigt die Karte, ob es geklappt hat und wie viele Funktionen ich nutzen kann. Dienste, bei denen man sich nur über ein Anmeldefenster anmelden kann, lassen sich so noch nicht verbinden.
