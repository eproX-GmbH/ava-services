---
id: ki-qualitaetsstufen
titel: Was bedeuten die Qualitätsstufen S, A, B und C der Modelle?
fragen:
  - was heißt stufe S beim modell
  - warum ist mein modell zu schwach
  - workflow anlegen blockiert stärkeres modell nötig
  - welche stufe hat mein modell
  - verflechtungen blockiert mit diesem modell
  - model tier erklärung
schlagworte: [stufe, tier, qualität, qualitätsstufe, stufe s, stufe a, stufe b, stufe c, workflow, verflechtungen, gesellschafterliste, vision, modell, blockiert]
aktionen:
  - { art: app_oeffnen, ziel: modell, label: "Modell wechseln" }
gilt_fuer: [desktop]
stand: 2026-11-07
---
Jedes Modell hat in AVA eine Qualitätsstufe: S ist die Spitzenklasse, A stark, B solide Mittelklasse, C klein. Die Stufe entscheidet zum Beispiel, ob ein neues Ergebnis bessere ältere Daten überschreiben darf. Ein schwächeres Modell überschreibt nie, was ein stärkeres schon gefunden hat.

Zwei Funktionen hängen an der Stufe:
- Workflows per Chat anlegen oder ändern geht nur mit einem Chat-Modell der Stufe S, zum Beispiel Claude Sonnet 5.5 oder Opus. Starten, Freigaben und Vorlagen gehen mit jedem Modell, und im Workflow-Editor kannst du immer von Hand bauen.
- Firmen-Verflechtungen (Gesellschafterlisten), falls deine Organisation sie freigeschaltet hat, brauchen für die Hintergrund-Verarbeitung ein Modell ab Stufe A, das Bilder versteht. Sonst steht unter Anbieter & Modell ein Hinweis, dass sie blockiert sind.

In der Modell-Liste steht die Stufe nicht dabei. Zur Orientierung bei den empfohlenen Modellen: Stufe S haben Claude Sonnet 5.5, Grok 4.6 und Qwen3.8 Max, Stufe A GPT-6 Luna, Gemini 3.8 Flash und Mistral Large 4, Stufe B DeepSeek V4 Flash.
