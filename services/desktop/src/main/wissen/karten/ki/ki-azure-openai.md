---
id: ki-azure-openai
titel: OpenAI über die eigene Azure-OpenAI-Ressource nutzen
fragen:
  - azure openai einrichten
  - wir haben openai nur über azure
  - deployment namen eintragen
  - microsoft azure statt openai
  - azure endpunkt hinterlegen
schlagworte: [azure, azure openai, microsoft, deployment, endpunkt, endpoint, ressource, openai, schlüssel, unternehmen]
aktionen:
  - { art: app_oeffnen, ziel: modell, label: "OpenAI-Karte öffnen" }
  - { art: chat_vorschlag, ziel: "Prüfe meine Verbindung zu Azure OpenAI.", label: "Azure-Verbindung prüfen" }
gilt_fuer: [desktop]
stand: 2026-11-07
---
Nutzt ihr OpenAI über eine eigene Azure-Ressource, geht das mit deinem OpenAI-Schlüssel als Azure-Schlüssel. Endpunkt und Zuordnung der Modelle kann ich dir eintragen, prüfen oder wieder ausschalten, du bestätigst vorher.

Selbst geht es unter Einstellungen → KI & Kosten → Anbieter & Modell → API-Schlüssel → OpenAI. Dort den Haken „Über Azure OpenAI (eigene Azure-Ressource)“ setzen, den Endpunkt eintragen (etwa https://firma.openai.azure.com) und unter „Modell → Name bei Azure“ angeben, wie die Modelle bei euch heißen. Ohne Eintrag nimmt AVA denselben Namen wie das Modell, „Alle übrigen Modelle“ fängt den Rest auf. Dann „Azure speichern“ und „Verbindung prüfen“. Den Azure-Schlüssel trägst du oben in der OpenAI-Karte ein.

Grenzen: Der Sprachmodus geht mit Azure nicht, er braucht einen Schlüssel direkt bei OpenAI. Websuche und Deep Research klappen nur, wenn eure Azure-Ressource die passenden Modelle anbietet.
