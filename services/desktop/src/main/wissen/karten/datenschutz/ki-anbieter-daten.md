---
id: ki-anbieter-daten
titel: Welche Daten gehen an den KI-Anbieter?
fragen:
  - sieht openai meine daten
  - geht etwas an chatgpt
  - werden meine daten zum training genutzt
  - welche daten bekommt die ki
  - lokales modell und datenschutz
  - ki anbieter dsgvo
schlagworte: [ki, anbieter, openai, anthropic, google, mistral, chatgpt, lokal, ollama, datenschutz, training, api key, azure, organisationsschlüssel, prompt-audit, mitlesen, liest mit]
aktionen:
  - { art: app_oeffnen, ziel: modell, label: "Anbieter & Modell" }
stand: 2026-11-07
---
Für den Chat hängt das davon ab, womit ich denke:

- Lokales Modell: Der Chat bleibt auf deinem Rechner, nichts geht an einen KI-Anbieter.
- Eigener Schlüssel oder ChatGPT-Abo: Deine Nachrichten und die Inhalte, die ich dafür lese, gehen direkt von deiner AVA an diesen Anbieter. Den Vertrag mit ihm schließt du selbst.
- Schlüssel deiner Organisation: Dieselben Inhalte laufen über den AVA-Server in Frankfurt zum Anbieter. Gespeichert werden dort nur Zähler, Inhalte nur mit eingeschaltetem Prompt-Audit.

Die Aufbereitung deiner Firmen, also das Auswerten von Register, Website, Abschlüssen und Ansprechpartnern, läuft in der Regel über ein Modell, das AVA selbst bereitstellt, ebenfalls über den AVA-Server. Dabei gehen öffentliche Firmentexte samt der dort genannten Ansprechpartner an den KI-Anbieter, nicht deine Chats.

Ob ein Anbieter Daten zum Training nutzt, regeln dessen Bedingungen; das kann ich nicht für ihn zusagen. Deinen Weg siehst du unter Einstellungen → KI & Kosten → Anbieter & Modell.
