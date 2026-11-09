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

## Pflege bei jeder Änderung an AVA (Regel, Joyce 2026-11-08)

Wer eine Funktion, einen Text, einen Ablauf oder eine Einstellung in AVA ändert, prüft
im selben Zug die betroffenen Karten und passt sie an (Suche: `grep -rl "<Begriff>" karten/`).
Neue Funktion = neue Karte oder Ergänzung einer bestehenden; entfernte Funktion = Karte
anpassen oder löschen. Dazu gehören:

1. **Text** der Karte (Lösung, Fragen, Schlagworte, Aktionen) und `stand:` auf das Datum der Änderung.
2. **Prüfsatz**: für neue oder geänderte Karten mindestens eine Frage in `../pruefsatz.json`.
3. **Suche prüfen**, beide Wege:
   - `../../node_modules/.bin/tsx scripts/test-wissen.mts` (Volltext/BM25, muss 0 kaputte Karten melden)
   - `../../node_modules/.bin/tsx scripts/test-wissen.mts --vektoren` (mit Vektoren über das lokale Ollama, embeddinggemma)
   Die Trefferquote darf nicht sinken (Stand 2026-11-09: 295 Karten, Volltext 252/257, mit Vektoren 248/257).
   Beide Läufe melden veraltete Kartenvektoren als FEHLER.
4. **Vektoren vorberechnen** (Pflicht nach jeder Kartenänderung, vor Schritt 3):
   `../../node_modules/.bin/tsx scripts/wissen-vektoren.mts --ollama http://127.0.0.1:11555`
   Die Kartenvektoren (Titel + Fragen) entstehen beim Entwickeln, nie auf dem Gerät des Nutzers,
   und liegen der App als `../vektoren.json` bei (`vektoren-datei.ts`). Gerechnet wird mit
   demselben Modell wie in der App: `embeddinggemma:latest`, Manifest-Digest in
   `VEKTOR_MODELL_DIGEST`; das Skript lehnt einen anderen Stand ab. Am besten mit AVAs eigenem
   Ollama (Pin aus `ollama-pin.ts`), z. B. auf Port 11555:
   `OLLAMA_HOST=127.0.0.1:11555 ~/Library/Application\ Support/@ava/desktop/shared/ollama-managed/v0.40.5/ollama serve`.
   Unveränderte Karten behalten ihren Vektor, nur geänderte werden neu eingebettet. Auf dem
   Gerät wird nur die Frage eingebettet (4 s Frist, danach 10 Minuten nur Volltext).
5. **Keine Release-Bündelung ohne Karten**: Karten gehören in denselben Commit wie die Änderung,
   damit App und Wissen im selben Release zusammenpassen.
