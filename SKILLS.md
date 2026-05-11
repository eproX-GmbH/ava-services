# AVA Skills — user-authored agent extensions

AVA reads user-written `SKILL.md` files at launch and exposes them to the
chat agent as personas, workflow templates, or domain knowledge. The
format is borrowed from Anthropic's AgentSkills standard and narrowed
by AVA's B2B-sales scope — see `PLANS.md` §2 for the full design.

## Where AVA looks

- **Per-user:** `<userData>/skills/<name>/SKILL.md`
  - macOS: `~/Library/Application Support/AVA/skills/<name>/SKILL.md`
- **Per-workspace (developer / team-shared):** `<repo>/.ava/skills/<name>/SKILL.md`,
  resolved relative to AVA's working directory. Only loaded if the
  directory exists.

If a skill name collides between scopes, the user-scope copy wins.

## Minimal example

```markdown
---
name: outreach-draft
description: >
  Schreibt einen Erstkontakt-Entwurf an einen Geschäftsführer einer
  deutschen mittelständischen Maschinenbau-Firma.
b2b-scope: outreach
---

# Outreach Draft

Verfasse einen kurzen, höflichen Erstkontakt-Entwurf auf Deutsch.
```

That's enough — every other field has a safe default.

## Frontmatter reference

| Feld | Pflicht | Default | Beschreibung |
|---|---|---|---|
| `name` | ja | — | Eindeutiger kebab-case-Bezeichner. Wird in `/skill-name` verwendet. |
| `description` | ja | — | Nicht-leerer Freitext. Der Agent entscheidet anhand der Beschreibung, wann das Skill aktiviert wird. |
| `language` | nein | `de` | `de` oder `en` — wählt die Prompt-Variante. |
| `b2b-scope` | **ja** | — | Eine von `outreach`, `qualifying`, `competitive`, `data-extraction`, `internal`. Alles andere wird abgewiesen. |
| `allowed-tools` | nein | `[]` | **Hart-erzwungene Tool-Allowlist.** Leer = das Skill darf gar keine Tools aufrufen (reine Prosa-Vorlage). |
| `requires-user-confirm` | nein | `true` | Erzwingt einen Bestätigungs-Schritt vor Side-Effects (Mails, CRM-Writes). |
| `disable-model-invocation` | nein | `false` | `true` = das Skill aktiviert sich nicht automatisch über Description-Match; nur explizite `/`-Aufrufe. |
| `user-invocable` | nein | `true` | `false` = `/skill-name` ist deaktiviert. |
| `arguments` | nein | `[]` | Liste von `{ name, description, required }` für `/skill-name $1 $2 …`. |
| `metadata.ava.requires` | nein | — | Gating-Block. Bekannte Keys: `crm`, `ollama`, `tier`. Wird beim Laden ausgewertet; ein nicht-erfüllter Gate führt zu einer übersprungenen Last (ab S2 mit echtem CRM- und Ollama-Status). |

## B2B-Scope-Werte

- `outreach` – Erstkontakt, Cold Email, Anschreiben.
- `qualifying` – Lead-Bewertung, Discovery-Fragebögen.
- `competitive` – Wettbewerber-Recherche, Vergleichsmatrizen.
- `data-extraction` – Strukturiertes Auslesen aus CRM, Web, PDFs.
- `internal` – Hilfsskills für Sales-Workflow-Hygiene (Notizen, Status-Updates).

Anything else (z. B. `travel-booking`, `personal-assistant`) wird beim
Laden mit einer deutschen Fehlermeldung im Log abgewiesen.

## Trust + hot-reload

- **Hot-reload:** Speichern einer `SKILL.md` löst einen Reload aus
  (200 ms Debounce). Kein App-Neustart nötig.
- **Trust-Dialog:** S4 wird einen Import-Bestätigungsdialog liefern
  (Liste der `allowed-tools`, `b2b-scope`, Body-Länge), sowie das
  Re-Confirm-on-Change-Verhalten aus PLAN §2.4 Regel 6. **In S1 liest
  AVA `SKILL.md`-Dateien einfach von der Platte.** Wer fremde Skills
  installiert, sollte sie bis dahin manuell prüfen.

## Validierungs-Fehler

Fehlerhafte Skills werden lautlos übersprungen, aber mit einer
deutschen Zeile im Log markiert, z. B.:

```
[skills] '/Users/.../skills/foo/SKILL.md' übersprungen:
  Feld 'b2b-scope' fehlt oder ist ungültig (erlaubt: outreach,
  qualifying, competitive, data-extraction, internal)
```

## Tool-Allowlist (ab S2 erzwungen)

`allowed-tools` ist eine **harte Allowlist** und gilt nur, solange das
Skill aktiv ist (per `/name` explizit aufgerufen ODER per Description-
Keyword-Match automatisch aktiviert).

- **Leere Liste (`[]` oder Feld weggelassen):** Das Skill darf KEINE
  Tools aufrufen. Jeder Versuch wird abgewiesen mit
  `"Skill '<name>' erlaubt keine Tool-Aufrufe (reines Prosa-Skill)."`.
  Die LLM sieht den Refusal-Text als Tool-Result und kann sich
  korrigieren.
- **Liste mit Einträgen:** Nur die genannten Tool-Namen sind erlaubt.
  Jeder andere Tool-Aufruf wird abgewiesen mit
  `"Tool '<tool>' ist im aktiven Skill '<skill>' nicht erlaubt (allowed-tools: [<liste>])."`.
- **Kein aktives Skill:** Standardverhalten, keine Allowlist.

Refusals werden zusätzlich mit `[skills] tool-call refused: skill=<name> tool=<tool>`
im Hauptprozess-Log markiert.

## `metadata.ava.requires` (Gates)

Skills mit unerfüllten Gates werden NICHT geladen — sie tauchen weder
im System-Prompt noch in der `/`-Liste auf, bis die Bedingung erfüllt
ist. Hot-Reload re-evaluiert beim nächsten Reload des Stores.

| Key | Wert | Bedeutung |
|---|---|---|
| `crm` | `hubspot` / `salesforce` / `dynamics` / `any` | Der genannte CRM-Provider muss in den Settings verbunden sein. `any` erlaubt jeden verbundenen Provider. |
| `ollama` | `installed` / `running` | Bundled Ollama-Binär muss installiert (`installed`) bzw. das Daemon up (`running`) sein. |
| `tier` | beliebig | Reserviert für ein zukünftiges Tier-System. Aktuell immer erfüllt (TODO). |

Beispiel:

```yaml
metadata:
  ava:
    requires:
      crm: hubspot
      ollama: running
```

## Explizite `/skill-name`-Aufrufe

Tippt der Nutzer in einer Chat-Nachricht eine erste Zeile, die mit
`/skill-name` beginnt (kebab-case, optional gefolgt von Argumenten),
lädt AVA den Body des passenden Skills in den Konversationskontext.
Beispiel:

```
/qualifying-deep ACME-123
```

- Der Body wird VOR dem Senden an das LLM als zusätzliche Nutzer-
  Nachricht eingehängt, mit dem Prefix `### Skill: <name>\n\n`.
- `$ARGUMENTS` im Body wird durch den rohen Argument-String ersetzt
  (`ACME-123`).
- Pro deklariertem `arguments[]`-Eintrag wird `${name}` durch das
  positionell passende Token aus dem Argument-String ersetzt.
- Das aktivierte Skill bleibt für die Dauer dieses Turns "aktiv" und
  unterliegt damit der Tool-Allowlist (siehe oben).
- Skills mit `user-invocable: false` ignorieren den `/`-Aufruf und
  bleiben einfach Prosa.

## Auto-Aktivierung

Ohne expliziten `/`-Aufruf scannt AVA die letzte Nutzer-Nachricht auf
Keywords aus der `description` jedes Skills. Skills, die mindestens
**zwei distinct** Keywords ≥ 4 Zeichen treffen, kommen in die Auswahl;
der Treffer mit den meisten Hits aktiviert sich (bei Gleichstand der
erste geladene). Das ist bewusst eine grobe Heuristik — ein semantischer
Match landet später.

Skills mit `disable-model-invocation: true` werden bei der Auto-
Aktivierung übersprungen, nur `/name` startet sie noch.

## Rollout

- **S1 (v0.1.121)** – Loader + Schema + Hot-Reload.
- **S2 (v0.1.122)** – Agent-Integration: System-Prompt-Block,
  `/skill-name`-Invocation, erzwungene Tool-Allowlist, Gate-Evaluator
  für `metadata.ava.requires` (dieser Stand).
- **S3** – Settings → Skills (read-only).
- **S4** – In-App-Editor + Trust-Dialog + Save.
- **S5** – Import / Export (zip drag-drop) + Re-Confirm-on-Change.
- **S6** – Drei Starter-Skills out-of-the-box.
