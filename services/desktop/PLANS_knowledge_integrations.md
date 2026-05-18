# Knowledge-Integrationen (Notion, Obsidian) + Self-Authoring Skills

> Status: P1 ausgeliefert (v0.1.224) · P2-P6 ausstehend
> Related: `PLANS_chart_skill.md`, `PLANS_token_usage_tab.md`, bestehende `skills/`, `agent/tools/watches.ts`, `crm/`-Modul

## Entscheidungen (festgezurrt)

1. **Notion-Auth: PAT** (kein OAuth-Marketplace).
2. **Obsidian: nur Plugin-Pfad** (kein Filesystem-Fallback in Phase 1).
3. **Self-Authoring Skills: User-Confirmation per Skill** (kein Auto-Trust).
4. **Kein paralleler Notion-OAuth-Approval-Anstoß.**

## Ausgeliefert

### v0.1.224 — Phase 1 ✓
- Token-Redaktion vor Disk-Write in `MemoryStore.append()` (`knowledge/redaction.ts`).
- Pattern-Bibliothek: Notion (legacy + neu), Anthropic (Sub + API), OpenAI (proj/svcacct/std), Google, Mistral, GitHub (PAT + fine-grained), Slack, HubSpot.
- `KnowledgeAdapter`-Interface (`main/knowledge/types.ts`).
- `KnowledgeProviderStore` mit safeStorage-Tokens + atomic Status-JSON (`main/knowledge/store.ts`).
- IPC `knowledge:getSnapshot` + Live-Event `knowledge:snapshotChanged`.
- Settings → Wissensquellen-Tab (Placeholder mit Provider-Liste, „noch nicht verbunden"-Status).

### v0.1.225 — Phase 2 (Notion) ✓
- Tool-Call-Argumente werden jetzt ebenfalls redacted (rekursiver Walk in `sanitiseForDisk`) — Tokens via `notion_connect_save_token({token: "ntn_…"})` landen nicht im Transcript.
- `NotionAdapter` (hand-rolled gegen Notion-REST-API, kein SDK): search, getItem, updateItem, createItem, introspectSchema, listDatabases, queryDatabase.
- Markdown ↔ Notion-Block-Konverter: paragraph / heading_1-3 / bulleted_list_item / numbered_list_item / to_do / quote / code / divider. Komplexere Block-Typen erscheinen als `[type-Block]`-Placeholder.
- Property-Konverter: title / rich_text / select / multi_select / date / number / checkbox / url / email / phone_number / status / people.
- `KnowledgeManager` (Singleton, Routing pro Provider-Kind).
- 10 Chat-Tools: `notion_connect_start`, `notion_connect_save_token`, `notion_disconnect`, `notion_search`, `notion_list_databases`, `notion_introspect_database`, `notion_query_database`, `notion_get_page`, `notion_create_page`, `notion_update_page`.
- IPC `knowledge:connect` / `knowledge:disconnect` / `knowledge:listNotionDatabases`.
- Settings → Wissensquellen-Tab funktional: Verbinden-Form mit 5-Schritt-Anleitung + Token-Input, Trennen-Button, Status-Anzeige.
- Notion-API-Errors humanisiert: 401 → "Token ungültig", 403 → "AVA hat keinen Zugriff (Page → Connections)", 404, 429 (Rate-Limit).

## 1 — Motivation

Viele AVA-Nutzer nutzen **Notion** oder **Obsidian** als faktisches CRM, obwohl es definitorisch keine sind. Heute kann AVA mit ihnen nicht reden — der Workflow „setz mir Firma X im Notion-CRM auf den 20.5. zur Nachfass-Erinnerung" ist nicht möglich.

Gleichzeitig: AVAs **Skill-System** ist user-authored. Das LLM kann sich selbst keine Skills erstellen, obwohl genau das laut OpenClaw-Pattern den langfristigen Mehrwert liefert (einmal recherchieren wie die Notion-API funktioniert → für immer als Skill abgelegt).

Ziel dieses Plans: AVA wird zu einem System, das

1. **Notion und Obsidian** als Wissens-Backends versteht und live mit ihnen arbeitet.
2. Sich aus dem Chat heraus **neue Capabilities erlernen und als Skill abspeichern** kann.
3. **Datum-basierte Erinnerungen** aus dem externen System (z. B. „Am 20.5. nachfassen" als Notion-Datum-Feld) eigenständig erkennt, terminiert und am Tag X als Push pusht — ohne Doppel-Pushes.
4. **Sensitive Daten** (API-Tokens) aus dem Chat sicher entgegennimmt, persistiert, aber **nicht im Chat-Transcript** ablegt.
5. **Erledigte Aufgaben aus dem Gedächtnis bereinigt** — was nach erfolgreicher Push-Notification keinen Wert mehr hat, wird automatisch gelöscht.

## 2 — Architektur-Überblick

Drei neue Konzept-Säulen, parallel zur bestehenden CRM-Säule:

```
                ┌──────────────────────────────────┐
                │  Knowledge-Integration-Framework │
                │  (neue Klasse, NICHT unter CRM)  │
                ├──────────────────────────────────┤
                │  - Provider-Adapter pro System    │
                │  - Schema-Introspection           │
                │  - Generic read/write/search ops  │
                │  - OAuth bzw. PAT-Auth            │
                └──────────────────────────────────┘
                              │
       ┌──────────────────────┼─────────────────────┐
       ▼                      ▼                     ▼
  ┌──────────┐         ┌─────────────┐       ┌────────────┐
  │ Notion   │         │ Obsidian    │       │ Future:    │
  │ Adapter  │         │ Adapter     │       │ AppleNotes │
  │ (API +   │         │ (Local-REST-│       │ Bear, …    │
  │  PAT)    │         │  API-Plugin)│       │            │
  └──────────┘         └─────────────┘       └────────────┘

                ┌──────────────────────────────────┐
                │  Self-Authoring Skills            │
                │  (Erweiterung des Skill-Systems)  │
                ├──────────────────────────────────┤
                │  - Chat-Tools: skill_save,        │
                │    skill_research_and_save        │
                │  - Pre-Persist-Validation         │
                │  - Trust-Gate für autonome       │
                │    Skill-Schreiben                │
                └──────────────────────────────────┘

                ┌──────────────────────────────────┐
                │  Reminder-Engine (Datum-basiert)  │
                ├──────────────────────────────────┤
                │  - Neuer Watch-Kind: due-date     │
                │  - Heartbeat-Hook (alle 15 min)   │
                │  - Idempotency-Bookkeeping        │
                │    ("schon notifiziert?")         │
                │  - Memory-Cleanup-Trigger nach    │
                │    erfolgreichem Push             │
                └──────────────────────────────────┘
```

## 3 — Sensitive-Daten im Chat (Querschnittsthema, Phase 1)

Bevor wir Notion-Tokens via Chat entgegennehmen, brauchen wir einen sauberen Pfad:

### 3.1 Pre-Persist-Redaktion

Der `MemoryStore.formatMessage()`-Pfad (`agent/memory.ts`) bekommt einen Redaction-Hook, der bekannte Token-Patterns aus User-Messages **vor dem Disk-Write** ersetzt:

```ts
const TOKEN_PATTERNS: { re: RegExp, label: string }[] = [
  { re: /\bsecret_[A-Za-z0-9]{40,}\b/g, label: "Notion-Integration-Token" },
  { re: /\bntn_[A-Za-z0-9_]{40,}\b/g, label: "Notion-Integration-Token (neueres Format)" },
  { re: /\bsk-ant-[A-Za-z0-9_-]{50,}\b/g, label: "Anthropic-API-Key" },
  { re: /\bsk-[A-Za-z0-9]{40,}\b/g, label: "OpenAI-API-Key" },
  { re: /\bxoxb-[A-Za-z0-9-]{40,}\b/g, label: "Slack-Bot-Token" },
  { re: /\bAIza[A-Za-z0-9_-]{30,}\b/g, label: "Google-API-Key" },
];
```

Bei Match wird der Token-String mit `[redacted: <label>]` ersetzt. Der **Original-Token** wird gleichzeitig an den Token-Store (OS-Keychain via safeStorage) weitergereicht, sofern der laufende Tool-Kontext ihn erwartet.

### 3.2 Tool-bewusste Token-Aufnahme

Der Chat-Tool `connect_knowledge_provider` bekommt einen `pendingToken`-Slot. Wenn der User in seiner Nachricht einen Token im erwarteten Format pastet, wird er

- **vor** der Transcript-Persistierung extrahiert
- direkt an den Token-Store weitergegeben
- im Tool-Result als „gespeichert" bestätigt — **nie** als Echo im Assistant-Text

### 3.3 UI-Feedback

Wenn das Redaction-System feuert, sieht der Nutzer in der Chat-Bubble den ersetzten Platzhalter (`[redacted: Notion-Integration-Token]`). Damit ist transparent, dass AVA den Token erkannt **und** sicher abgelegt hat.

## 4 — Knowledge-Integration-Framework (Phase 1)

### 4.1 Daten-Modell

```ts
// services/desktop/src/shared/types.ts
export type KnowledgeProviderKind = "notion" | "obsidian";

export interface KnowledgeProviderStatus {
  kind: KnowledgeProviderKind;
  connected: boolean;
  /** Bezeichner aus dem externen System — z. B. Notion-Workspace-Name
   *  oder Obsidian-Vault-Pfad. */
  displayName: string | null;
  errorMessage: string | null;
  /** Letzte erfolgreiche Schema-Introspection. */
  lastSchemaSyncAt: string | null;
}
```

### 4.2 Adapter-Interface

```ts
// services/desktop/src/main/knowledge/types.ts
export interface KnowledgeAdapter {
  readonly kind: KnowledgeProviderKind;

  connect(credentials: unknown): Promise<KnowledgeProviderStatus>;
  disconnect(): Promise<void>;
  getStatus(): KnowledgeProviderStatus;

  /** Suche im verbundenen Vault/Workspace. */
  search(query: string, opts?: { limit?: number }): Promise<KnowledgeSearchHit[]>;

  /** Ein einzelnes Item (Notion-Page / Obsidian-Note) laden. */
  getItem(id: string): Promise<KnowledgeItem>;

  /** Item updaten — Adapter-spezifische ops (Block-Append, Property-
   *  Update, Frontmatter-Patch). */
  updateItem(id: string, patch: KnowledgeUpdate): Promise<KnowledgeItem>;

  /** Neues Item anlegen. */
  createItem(parent: string | null, content: KnowledgeContent): Promise<KnowledgeItem>;

  /** Datenbank/Sammlung-Schema introspectieren — kritisch für CRM-
   *  Use-Cases (welche Properties hat die User-Datenbank?). */
  introspectSchema(databaseId?: string): Promise<KnowledgeSchema>;
}
```

### 4.3 Speicher

- **Tokens / API-Keys** → OS-Keychain via `safeStorage` (analog zu CRM und Anthropic-Subscription)
- **Status / Schemas (gecacht)** → lokale PGlite `<userData>/pglite/knowledge/` (analog Audit/Usage-Stores)
- **Schema-Snapshot** wird beim Verbinden + täglich + on-demand frisch geholt; LLM bekommt im Tool-Result immer ein „so sieht die DB gerade aus"-Block

## 5 — Notion-Adapter (Phase 2)

### 5.1 Auth-Flow via Chat

Standardpfad: **Personal Access Token (PAT)**, weil Notion-OAuth eine eigene App-Registrierung verlangt (für AVA-als-Marketplace-App wäre das Voraussetzung; wir starten mit PAT).

Schritte, die AVA dem User im Chat erklärt:

1. „Geh auf https://www.notion.so/profile/integrations und erstelle eine Integration namens AVA."
2. „Kopier den `secret_…`-Token (oder `ntn_…`).
3. „In Notion: öffne den Workspace/die Seite, die AVA sehen soll → `…`-Menü → `Connections` → AVA hinzufügen.
4. „Schick mir den Token, ich speichere ihn sicher."

Bei Token-Paste greift die Pre-Persist-Redaktion aus §3 + Adapter speichert via Keychain.

### 5.2 Tool-Surface (Chat)

Erste Welle:
- `notion_search(query)` — Workspace-weite Suche
- `notion_get_page(pageId)` — Einzelseite laden, Blocks + Properties
- `notion_query_database(databaseId, filter?, sort?)` — strukturierte DB-Abfrage
- `notion_introspect_database(databaseId)` — Schema (Properties + Types)
- `notion_create_page({ parent, properties, content[] })` — neue Seite / DB-Zeile
- `notion_update_page({ pageId, properties?, appendBlocks? })` — partielles Update
- `notion_list_databases()` — alle für AVA freigegebenen Datenbanken

### 5.3 CRM-Workflow (zentraler Use-Case)

User: „Trag im Notion-CRM Firma 'Eclat GmbH' ein, Branchenfokus Maschinenbau, Erstkontakt am 18.5."

AVA-Pipeline:
1. `notion_list_databases()` → identifiziert mögliche CRM-Datenbank (Heuristik: Name enthält "CRM"/"Companies"/"Kunden", Property-Set passt — z. B. Title + Email + Status)
2. `notion_introspect_database(crmDbId)` → Schema laden, **dynamisch** entscheiden auf welche Properties die User-Angaben gemappt werden
3. `notion_create_page({ parent: crmDb, properties: { Name: "Eclat GmbH", Branche: "Maschinenbau", ... } })`
4. Bestätigt im Chat: „Eintrag in Datenbank 'CRM Companies' angelegt. URL: …"

Wichtig: **kein Schema-Annahmen**. Wenn das User-CRM eine Property `Erstkontakt-Datum` heißt aber wir `Created` versucht hätten, würde Notion-API einen Property-Fehler werfen. Schema-Introspection vor Write ist Pflicht.

### 5.4 Bibliothek

Wir nehmen `@notionhq/client` (offizielles SDK, ~50 KB minified, kompatibel mit Electron-Main). Auth via Bearer-Token-Header.

## 6 — Obsidian-Adapter (Phase 3)

### 6.1 Plugin-basierter Pfad (empfohlen)

Voraussetzung: User installiert das **"Local REST API"-Plugin** (`obsidian-local-rest-api` von coddingtonbear) und aktiviert es. AVA erklärt das im Chat:

1. „In Obsidian: Settings → Community plugins → Browse → 'Local REST API' installieren + enablen."
2. „Im Plugin-Tab: API-Key kopieren."
3. „Schick mir den Key, ich speichere ihn sicher."

Plugin startet einen HTTPS-Server auf `https://127.0.0.1:27124` mit Self-Signed-Cert. AVA spricht das vom Electron-Main-Prozess an (mit `rejectUnauthorized: false` weil 127.0.0.1, oder Cert-Pin auf das Plugin-Cert).

### 6.2 Tool-Surface

- `obsidian_search(query)` — fulltext über das Vault
- `obsidian_read_note(path)` — Markdown + Frontmatter
- `obsidian_write_note(path, content, frontmatter?)` — neue Note oder Replace
- `obsidian_patch_note(path, { heading?, blockRef?, prepend?/append?/replace? })` — surgical edits (Plugin unterstützt das nativ)
- `obsidian_list_files(folder?)` — Vault-Struktur
- `obsidian_search_metadata(filter)` — Tag/Frontmatter-Filter

### 6.3 Fallback: Direkter Dateisystem-Pfad

Falls der User das Plugin nicht installieren will, **alternativer Pfad**: User gibt den Vault-Ordner-Pfad ein, AVA liest/schreibt `.md`-Dateien direkt. Risiko: gleichzeitige Schreibvorgänge von Obsidian (auto-save) und AVA können Race-Conditions erzeugen. Wir würden dann mit Datei-Locks arbeiten + Obsidian-Convention beachten (z. B. nicht in `.obsidian/`-Subordner schreiben).

Empfehlung: **Plugin-Pfad als Default, Filesystem-Fallback als Power-User-Option mit Warnhinweis.**

## 7 — Self-Authoring Skills (Phase 4)

### 7.1 Aktueller Stand

- Skill-Schema, Loader, Parser, Trust-Store, Save-IPC existieren.
- **Kein Chat-Tool** zum Speichern eines vom Agent verfassten Skills.

### 7.2 Erweiterung

Zwei neue Chat-Tools:

#### `skill_save`
Speichert einen Skill, den der Agent selbst formuliert hat. Inputs:
- `name` (slug)
- `description` (kurz)
- `allowedTools[]` (welche existierenden Tools darf der Skill nutzen)
- `body` (Markdown — die eigentliche Skill-Anleitung)
- `source: "agent-authored"` (Provenance)

Vor dem persistieren: Trust-Gate. Erste Implementation: User-Confirmation per `ask_user_choice`-Card („AVA möchte den Skill 'notion-crm-upsert' anlegen. Inhalt: … Speichern?"). Spätere Iterations können basierend auf Profile-Prefs eine Auto-Trust-Liste machen.

#### `skill_research_and_save`
Höher-stufiger Tool: nimmt ein Lernziel als Input („Lerne, wie man eine neue Zeile in einer Notion-Datenbank anlegt") und führt eine **innere Recherche-Schleife** durch:

1. Web-Search via existing `web_search`-Tool (wenn vorhanden — falls nicht, separater Plan-Punkt)
2. Synthese der Recherche-Ergebnisse zu einem Skill-Body
3. Validierung gegen das Skill-Schema
4. Speichern via `skill_save`

Funktioniert nur mit Frontier-Modellen (Claude Opus/Sonnet, GPT-5). Bei lokalen ≤14B-Modellen lehnt der Tool ab mit Hinweis „dafür ist dein aktuelles Modell zu klein; nutze ein größeres Modell oder schreibe den Skill in Settings → Skills manuell".

### 7.3 OpenClaw-Inspiration

OpenClaw's Skills sind **Markdown-Files mit Action-Definitionen + Beispielen + Templates**. Wir bleiben bei unserem existing Skill-Schema (`skills/schema.ts`), das ist ähnlich aufgebaut. Was wir ergänzen sollten: **Templates für gängige CRM-Workflows** als „Starter-Skills", die AVA bei Verbindung mit Notion/Obsidian automatisch (mit User-Konsent) vorschlägt:

- "Notion-CRM-Upsert" — neuer Kontakt anlegen oder bestehenden aktualisieren
- "Notion-Reminder-Sync" — Datum-Felder als Reminder einlesen
- "Obsidian-Daily-Note" — Eintrag in heutiger Daily-Note anlegen

## 8 — Datum-basierte Reminder-Engine (Phase 5)

### 8.1 Use-Case

Notion-CRM enthält Property `Wiedervorlage` (Datum). User: „Erinnere mich an alle Wiedervorlagen aus dem CRM, push 30 Min vor 9 Uhr." AVA: 
1. Speichert einen Watch (`kind: "due-date-from-knowledge"`) mit Provider-Ref + Filter
2. Heartbeat-Executor evaluiert alle 15 min: `notion_query_database(crmId, filter: Wiedervorlage <= heute + 1d)`
3. Für jeden gefundenen Eintrag: prüfen ob bereits notifiziert (lokaler Idempotency-Store)
4. Wenn nein → Alert anlegen + Push-Notification
5. Idempotency-Eintrag schreiben (key = `<watchId>:<itemId>:<dueDate>`)

### 8.2 Neuer Watch-Kind

`watch-store.ts` erweitern um `KnowledgeReminderWatch`:

```ts
interface KnowledgeReminderWatch {
  kind: "knowledge-reminder";
  providerKind: KnowledgeProviderKind;
  databaseId?: string;     // Notion-DB oder null für Obsidian-Vault-Suche
  dateProperty?: string;   // Notion-Property mit dem Datum
  /** Filter-DSL für Vor-Selektion. */
  filter?: KnowledgeFilter;
  /** Wie viele Tage vorher pushen. */
  leadDays: number;
  /** Push-Zeitpunkt (Lokale Uhrzeit "HH:MM"). */
  pushTime: string;
}
```

### 8.3 Idempotency

Neue lokale PGlite-Tabelle `reminder_history`:
```sql
CREATE TABLE reminder_history (
  watch_id   TEXT NOT NULL,
  item_id    TEXT NOT NULL,
  due_date   DATE NOT NULL,
  notified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (watch_id, item_id, due_date)
);
```

Vor jedem Push: Lookup. Wenn Eintrag existiert → skip. Wenn nicht → push + insert.

### 8.4 Memory-Auto-Cleanup nach Push

Wenn ein Reminder als Memory-Eintrag verlinkt ist (`memoryRefs: ["mem_abc"]` im Watch), wird nach erfolgreichem Push der Memory-Eintrag automatisch via `generalMemoryStore.delete(id)` entfernt.

Trigger: im `watch-executor.ts` nach `notifications.notifyForAlert(alert)` und erfolgreichem Idempotency-Insert.

### 8.5 LLM-getriebener Cleanup-Entscheider

Für nicht-eindeutige Fälle (z. B. Memory-Eintrag „User möchte zur Konferenz in Berlin am 20.5. erinnert werden" — verlinkter Watch hat gefeuert, ist der Eintrag jetzt obsolet?) lassen wir einen **kleinen LLM-Call** entscheiden: `generateObject({shouldDelete: boolean, reason: string})` mit dem Memory-Inhalt + Watch-Kontext. Bei `shouldDelete: true` → forget. Bei `false` → keep + Log-Eintrag.

## 9 — Phasen-Plan

Aufwandsschätzungen mit Frontier-Modell-Anbindung, ohne ausgiebigen Test-Coverage-Build-out.

### P1 — Sensitive-Token-Handling + Knowledge-Framework-Skelett *(~2 Tage)*

- Memory-Store Pre-Persist-Redaction
- Token-Pattern-Bibliothek
- `KnowledgeAdapter`-Interface + `KnowledgeProviderStore` (PGlite + Keychain)
- IPC-Stubs für Renderer
- Settings-Tab-Sektion "Wissensquellen" als leerer Container

### P2 — Notion-Adapter *(~3 Tage)*

- `@notionhq/client` integrieren
- PAT-Auth-Flow via Chat
- Tools: `notion_search` / `notion_get_page` / `notion_query_database` / `notion_introspect_database` / `notion_list_databases` / `notion_create_page` / `notion_update_page`
- Settings-UI: Verbinden / Status / Trennen
- Smoke-Test mit einem Beispiel-Workspace

### P3 — Obsidian-Adapter *(~2 Tage)*

- HTTPS-Client gegen Local-REST-API-Plugin
- Cert-Bypass für 127.0.0.1
- Tools: `obsidian_search` / `obsidian_read_note` / `obsidian_write_note` / `obsidian_patch_note` / `obsidian_list_files`
- Settings-UI-Erweiterung
- Plugin-Setup-Erklärung im Chat-Flow

### P4 — Self-Authoring Skills *(~3 Tage)*

- Chat-Tool `skill_save` mit User-Confirmation-Gate
- Chat-Tool `skill_research_and_save` (gated für Frontier-Modelle)
- Skill-Provenance-Feld (`source: "agent-authored"` vs `"user-authored"`)
- Settings → Skills-Tab: Anzeigen, ob ein Skill vom Agent verfasst wurde
- Trust-Store-Erweiterung (autonome Skill-Erstellung erfordert Profile-Setting „Auto-Trust agent-authored")
- Starter-Skills-Templates für Notion-CRM-Workflows

### P5 — Reminder-Engine *(~2 Tage)*

- Neuer Watch-Kind `knowledge-reminder` in `watch-store.ts`
- Watch-Executor-Branch für Date-Property-Lookup
- `reminder_history`-Tabelle (PGlite)
- Memory-Cleanup-Trigger nach erfolgreichem Push
- LLM-getriebener Cleanup-Entscheider für Edge-Cases
- Chat-Tool `reminder_register` (Convenience-Wrapper über `watch_register`)

### P6 — Polish + Onboarding *(~1 Tag)*

- Settings-Tab "Wissensquellen" voll
- Chat-Onboarding-Phrasen für neue Verbindungen ("Verbinde mein Notion")
- Audit-Trail-Kategorie `knowledge` neu (Notion-Connect, Skill-Authoring, …)
- Verbrauchs-Tab erkennt LLM-Calls aus Skill-Authoring-Flows

## 10 — Risiken + Followups

- **Notion-OAuth-App-Marketplace**: Wir starten mit PAT. Wenn Bedarf für „Sign in with Notion"-OAuth steigt, müssen wir die OAuth-App offiziell bei Notion registrieren (Approval-Prozess). Eigener Followup.
- **Obsidian-Plugin-Adoption**: Power-User installieren das Plugin gerne; Casual-User schrecken zurück. Filesystem-Fallback bewusst als Backup.
- **Self-Authoring Skills + lokale Modelle**: Funktioniert ehrlich nur mit Frontier-Modellen. Wir machen das transparent im Tool-Refusal.
- **Reminder-Engine-Timezone**: Notion liefert Datumsfelder oft ohne TZ. Wir nehmen User-Tz aus dem Profil als Default; Notion-DateTime-Properties mit expliziter TZ überschreiben.
- **Sensitive-Token im Chat-Suchindex**: `MemoryStore.search()` muss redacted Strings ignorieren. Test-Case: User postet vor einem Jahr einen Token (redacted) — Such-Query nach "secret_" findet jetzt keinen Token-Wert mehr.
- **Conflict mit existing CRM-Modul**: Knowledge-Integrations sind eine **eigene** Klasse. Nicht in `crm/` einsortieren, nicht im CRM-Settings-Tab anzeigen.

## 11 — Offene Entscheidungen vor P1

1. **PAT vs OAuth für Notion** — gehen wir mit PAT (schneller, beim User aufwändiger) oder direkt OAuth (langsamer Build, smoother UX, braucht aber Notion-Marketplace-Approval)?
2. **Plugin-Pflicht vs Filesystem-Fallback für Obsidian** — bauen wir den Fallback gleich mit oder als Followup?
3. **Self-Authoring Trust-Default** — first-time: User-Confirmation pro Skill (sicher) oder bereits ein Whitelist-Vorab-Setting („AVA darf in folgenden Kategorien selbst Skills schreiben")?
4. **Notion-OAuth-App-Reg jetzt initiieren?** Selbst wenn wir P2 mit PAT bauen, kann der Approval-Prozess Wochen dauern.
