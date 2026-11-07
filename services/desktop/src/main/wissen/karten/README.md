# Lösungskarten

Eine Karte beschreibt genau ein Anliegen eines Nutzers und wie AVA es löst. AVA findet
Karten über die Suche (`tool_search`, Abschnitt „Wissen“) und antwortet daraus. Plan:
docs/PLAN_LOESUNGSKARTEN.md.

## Ablage

`karten/<ast>/<id>.md`, `<ast>` = Themenast in Kleinbuchstaben (verbindungen, firmen,
recherche, meldungen, workflows, abrechnung, konto, ki, datenschutz, erste-schritte, chat).
Die Karten werden beim Bauen in die App gebacken; eine neue Karte braucht ein Release.

## Format

```markdown
---
id: dienst-verbinden
titel: Einen externen Dienst mit AVA verbinden
fragen:
  - verbinde dich mit CompLeadly
  - wie schließe ich ein Tool an
schlagworte: [dienst, verbindung, mcp, compleadly]
aktionen:
  - { art: app_oeffnen, ziel: dienst_verbinden, label: "Dienst verbinden" }
gilt_fuer: [desktop]
stand: 2026-11-07
---
Lösung in Nutzersprache, Du-Form, 80 bis 300 Tokens.
```

Pflicht: `id` (a-z, 0-9, Bindestrich, eindeutig), `titel` (das Anliegen, 4–140 Zeichen),
`fragen` (1–20 Beispielformulierungen, gern salopp), `stand` (JJJJ-MM-TT).
Optional: `schlagworte` (max 30), `aktionen` (max 4), `gilt_fuer` (Standard `[alle]`).
Unbekannte Felder im Kopf sind ein Fehler.

`aktionen`, je Eintrag:
- `art`: `app_oeffnen` | `zugang_anfordern` | `chat_vorschlag`
- `label`: Knopftext, 2–40 Zeichen, mit Umlauten
- `ziel`: bei `app_oeffnen` Pflicht, ein Ziel aus `agent/tools/app-oeffnen.ts`; bei
  `chat_vorschlag` Pflicht, der Auftrag als Satz; bei `zugang_anfordern` weglassen
- `dienst`: optional, bei `dienst_verbinden` und `zugang_anfordern` (z. B. `compleadly`)

`gilt_fuer`: `desktop` | `telegram` | `app` | `alle`. Karten, die Einstellungen der
Desktop-App brauchen: `[desktop]`.

## Text

- Nutzersprache: keine Werkzeugnamen, nicht „Tool“, „MCP“, „Token“, „Schema“ im
  Lösungstext (in `fragen`/`schlagworte` erlaubt, damit die Suche sie findet).
- Umlaute (ä ö ü ß), keine Geviertstriche, keine Verweise auf Pläne oder Repo-Pfade.
- Nur behaupten, was AVA heute kann. Unklares nicht schreiben, sondern im Inventar als
  Frage sammeln.

## Prüfsatz

`../pruefsatz.json`: `[{ "frage": "…", "erwartet": "<id>" | ["<id>", …] }]`. Treffer =
eine erwartete id unter den ersten drei. Prüfen mit
`../../node_modules/.bin/tsx scripts/test-wissen.mts` in services/desktop.
