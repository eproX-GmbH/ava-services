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
| `metadata.ava.requires` | nein | — | Gating-Block. Bekannte Keys: `crm`, `ollama`, `tier`. Wird beim Laden ausgewertet; ein nicht-erfüllter Gate führt zu einer übersprungenen Last (in S1 wird jeder gesetzte Eintrag als nicht erfüllt behandelt; reale Auswertung folgt in S2). |

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

## Rollout

- **S1 (v0.1.121)** – Loader + Schema + Hot-Reload (dieser Stand).
- **S2** – Agent-Integration: Description-Match im System-Prompt,
  `/skill-name`-Invocation, Tool-Allowlist-Enforcement.
- **S3** – Settings → Skills (read-only).
- **S4** – In-App-Editor + Trust-Dialog + Save.
- **S5** – Import / Export (zip drag-drop) + Re-Confirm-on-Change.
- **S6** – Drei Starter-Skills out-of-the-box.
