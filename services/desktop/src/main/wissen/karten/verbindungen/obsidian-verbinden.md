---
id: obsidian-verbinden
titel: Obsidian mit AVA verbinden
fragen:
  - verbinde mein obsidian vault
  - obsidian anbinden
  - obsidian local rest api einrichten
  - verbindung zu obsidian verweigert
  - kannst du in meine obsidian notizen schreiben
schlagworte: [obsidian, vault, local rest api, plugin, coddingtonbear, api key, schlüssel, port 27123, 127.0.0.1, markdown, notizen, tags]
aktionen:
  - { art: chat_vorschlag, ziel: "Welche Notizen liegen in meinem Obsidian?", label: "Notizen zeigen" }
gilt_fuer: [desktop]
stand: 2026-11-07
---
Obsidian verbinde ich über das Plugin „Local REST API“. So geht es:

1. In Obsidian unter Settings → Community plugins das Plugin „Local REST API“ (von coddingtonbear) installieren und aktivieren. Falls nötig vorher den „Restricted mode“ ausschalten.
2. In den Einstellungen des Plugins den Schlüssel („API Key“) kopieren.
3. In AVA unter Einstellungen → Verbindungen → Notizen bei Obsidian auf „Verbinden“ klicken und den Schlüssel einfügen. Die Base-URL http://127.0.0.1:27123 ist vorbelegt und passt meist.

Danach kann ich deine Notizen lesen, durchsuchen, nach Tags finden, neue anlegen und bestehende ergänzen. Obsidian muss dafür auf diesem Rechner laufen. Meldet die Verbindung „verweigert“, ist Obsidian zu oder das Plugin aus.
