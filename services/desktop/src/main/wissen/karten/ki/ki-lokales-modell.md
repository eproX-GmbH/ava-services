---
id: ki-lokales-modell
titel: Ein lokales KI-Modell auf dem eigenen Rechner nutzen (Ollama)
fragen:
  - kann ava offline ohne cloud laufen
  - lokales modell installieren
  - ollama modell laden
  - welches lokale modell für 16 gb ram
  - ki auf meinem rechner statt cloud
  - local llm
schlagworte: [lokal, ollama, offline, llm, qwen, gemma, llama, ram, arbeitsspeicher, download, herunterladen, kostenlos, datenschutz]
aktionen:
  - { art: app_oeffnen, ziel: modell, label: "Lokales Modell wählen" }
  - { art: chat_vorschlag, ziel: "Lade das lokale Modell Qwen 3 8B herunter.", label: "Qwen 3 8B laden" }
  - { art: app_oeffnen, ziel: lokale_modelle, label: "Lokale Modelle öffnen" }
gilt_fuer: [desktop]
stand: 2026-11-07
---
AVA bringt eine lokale KI (Ollama) mit. Ein lokales Modell kostet nichts und deine Chat-Anfragen bleiben auf dem Rechner. Dafür ist die Qualität merklich schwächer als bei Cloud-Modellen, vor allem bei mehrstufigen Aufgaben, und du brauchst genug Arbeitsspeicher.

Ich kann ein Modell für dich herunterladen, den Stand zeigen oder ein Modell wieder löschen. Selbst wählst du unter Einstellungen → KI & Kosten → Anbieter & Modell den Anbieter „Ollama (lokal)“ und dann ein Modell. Ist es noch nicht auf der Festplatte, klickst du „Modell herunterladen“. Der Download läuft im Hintergrund, den Fortschritt siehst du unten rechts.

Orientierung nach Arbeitsspeicher: Qwen 3 8B ab 16 GB als Einstieg, Qwen 3 14B ab 16 GB für mehrstufige Recherchen, Gemma 4 26B ab 24 GB, Qwen 3 30B ab 32 GB, Llama 3.3 70B ab 48 GB. Der Bedarf steht auch im Namen in der Liste. Hat deine Organisation Anbieter und Modell festgelegt, gibt es die lokale Auswahl nicht.
