# Changelog

Notable changes per release of `@ava/desktop`. Older releases (pre-v0.1.90) are
not back-filled here; check `git log --grep "(v0.1."` for tagged context.

The repo uses one rolling tag per desktop release (`v<major>.<minor>.<patch>`)
on `main`. Submodules cut their own feature branches and are pinned via the
desktop bundle; `pnpm fetch:producers` re-vendors them into the .dmg.

## v0.1.128 — 2026-05-11

- **Slash-Befehls-Palette im Chat.** Tippt man `/` ins Chat-Eingabefeld,
  öffnet sich über dem Composer ein Popover mit allen verfügbaren
  Skills (aktiviert, vertraut, Gate erfüllt, user-invocable) sowie den
  registrierten Agent-Tools. Auswahl per Pfeiltasten + Enter/Tab oder
  Klick fügt `/<name>` plus Leerzeichen in den Composer ein; Escape
  schließt die Palette, ohne den Text zu verwerfen. Gesendete
  User-Bubbles rendern das führende `/<name>` als Aqua-Pill, damit der
  Skill-Aufruf im Verlauf auf einen Blick erkennbar ist. Die
  orchestrator-seitige `/skill-name`-Verarbeitung aus S2 bleibt
  unverändert; Tool-Namen werden als Hinweis eingefügt, den das LLM
  in der nächsten Turn aufgreift. Neue Datei
  `components/chat/SlashPalette.tsx`, in `ChatSession.tsx` und
  `Chat.tsx` (UserBubbleContent) verdrahtet. Die IPC
  `skills:listAvailableTools` liefert jetzt
  `{ name, description }[]` statt nur `string[]`; SkillEditor mappt
  weiterhin auf Namen.

## v0.1.127 — 2026-05-11

- **Skill-Editor-Modal: Layout-Fix.** Im S4-Editor überlappten Labels,
  Eingabefelder und Hilfetexte (zum Beispiel „Nur Kleinbuchstaben…"
  lief in das nächste „Beschreibung"-Label), weil die `<label
  class="form-field">`-Wrapper keine CSS-Regel hatten und Inhalte
  inline statt block flossen. Neue `.skill-modal .form-field`-Regeln
  in `styles.css` setzen jedes Feld auf `flex-direction: column` mit
  klarem Gap, vereinheitlichen Label-Typografie und sorgen für
  `min-width: 0`, damit lange Beschreibungstexte den Grid-Spalten
  nicht den Boden ausziehen. Gleichzeitig wächst der Modal-Panel-
  Max-Width von 720px auf `min(96vw, 1400px)` (das alte CSS-Limit
  überschrieb den inline gesetzten 1100px-Wert) — bei breiten
  Displays haben Metadaten- und Body-Spalten jetzt deutlich mehr
  Luft.

## v0.1.126 — 2026-05-11

- **[PLAN §2 S5] Skills-Import/Export + Re-Confirm-on-Change-Politur.**
  Der Skills-Workflow ist damit feature-komplett gegenüber PLANS.md §2;
  einzig S7 (Marketplace) bleibt offen, ist aber außerhalb des
  v0.2-Scopes.
  - **Export.** Jede Skill-Karte hat einen *Exportieren*-Knopf, der
    ein `<name>.zip` mit dem rohen `SKILL.md` über Electrons nativen
    Save-Dialog ablegt. Section-Button *Alle exportieren* bündelt alle
    Nutzer-Skills (Workspace-Scope bleibt absichtlich außen vor — der
    kanonische Ort sind die Repo-Dateien) in
    `ava-skills-<YYYY-MM-DD>.zip` mit Layout `<name>/SKILL.md` und
    einer Top-Level-`MANIFEST.json` (`{exportedAt, skills:[{name,
    b2bScope, hash, exportedAt}, …]}`) für forensische Klarheit.
  - **Import.** Drei Einstiege gehen auf dieselbe Pipeline: der
    *Importieren*-Knopf (Open-Dialog für `.zip`/`.md`), Drag-and-Drop
    auf den Skills-Abschnitt und ein einklappbares
    *SKILL.md einfügen*-Textfeld. Der Import läuft zweistufig: zuerst
    stagen wir das Paket in ein temporäres Verzeichnis, parsen +
    validieren jedes `SKILL.md` durch dieselben `parser` + `schema`-
    Module wie der Loader und liefern dem Renderer einen
    `SkillImportResult` mit `staged[]` (inkl. `action`: `create` /
    `overwrite-trusted` / `overwrite-modified` /
    `overwrite-untrusted` und ggf. `previousAllowedTools`) plus einer
    `conflicts[]`-Liste für YAML- oder Schema-Fehler. Erst beim Klick
    auf den Commit-Button im Import-Dialog werden Dateien nach
    `<userData>/skills/<name>/SKILL.md` geschrieben.
  - **Vertrauensentscheidung beim Commit.** Zwei Wege:
    *Alle importieren + vertrauen* (Auto-Trust gegen den on-disk
    Hash) oder *Nur importieren, nicht vertrauen* — letzteres
    schreibt die Datei und widerruft jeden vorhandenen Trust-Eintrag,
    sodass eine teamintern geteilte "v2" zwingend erneut freigegeben
    werden muss, selbst wenn "v1" früher mal freigegeben war.
  - **UX-Politur für Re-Confirm.** Über der Skill-Liste erscheint ein
    Banner *Vertrauensänderungen* wenn mindestens ein Skill auf
    `trust: "modified"` steht; *Alle prüfen* führt durch die offenen
    Trust-Dialoge in Folge. Default-Selektion im Import-Dialog ist
    opt-in für `create` und opt-out für jeden Overwrite, der neue
    `allowed-tools` mitbringt — der Nutzer muss aktiv zustimmen,
    bevor breitere Berechtigungen durchrutschen können.
  - **Neue IPC-Channels:** `skills:export`, `skills:exportAll`,
    `skills:pickImportFile`, `skills:importZip`,
    `skills:importMarkdown`, `skills:commitImport`,
    `skills:cancelImport`. Staging-Verzeichnisse sind ephemer
    (kein Cross-Restart-State) und werden nach Commit oder Cancel
    wieder entfernt.
  - **Neue Dependency:** `adm-zip` (klein, keine Native-Bindings).
  - **Neuer Test:** `pnpm test:skills:import` deckt Export-Round-Trip
    (Hash matches), gemischte Zips (valide + fehlerhafte
    Frontmatter), Overwrite mit neuem allowed-tool (Diff +
    previousAllowedTools), Markdown-Direkt-Import, Commit-Schreiben
    in tmp-Verzeichnisse und den Re-Confirm-Loophole-Closer beim
    `deferred`-Commit ab.

## v0.1.125 — 2026-05-11

- **[PLAN §2 S4] In-App-Skill-Editor + Trust-Dialog + Delete.** Skills
  können jetzt vollständig in AVA verfasst, bearbeitet und gelöscht
  werden — *Einstellungen → Skills* zeigt zusätzlich zur S3-Liste die
  Buttons *Neues Skill*, *Bearbeiten* und *Löschen*. Der Editor ist
  ein zweispaltiges Modal: links das Frontmatter-Formular
  (kebab-case-validierter Name, ≤500-Zeichen-Description,
  `b2b-scope`-Dropdown, `allowed-tools`-Chip-Multi-Select mit
  Filter-Suche über die Live-Tool-Registry, Flags, repeatable
  Argumente), rechts ein `<textarea>` für den Markdown-Body mit
  optionaler `react-markdown`-Vorschau und Zeichen-/Zeilenzähler.
  Speichern validiert clientseitig, anschließend nochmals serverseitig
  via `yup` (Defence in Depth), schreibt YAML-Frontmatter +
  Markdown-Body in `<userData>/skills/<name>/SKILL.md` und triggert
  einen Loader-Reload.
- **Vertrauensmodell für Skills (PLAN §2.4 Regel 5+6).** Jedes
  Skill bekommt einen Trust-Status (`trusted` / `untrusted` /
  `modified`) auf Basis von `<userData>/skills-trust.json`. Der
  Orchestrator-Filter `availableSkills()` gating-t zusätzlich auf
  `trust === "trusted"` — nicht-getrustete Skills bleiben in der
  Liste sichtbar (mit gelbem/roten Pill in der UI), feuern aber weder
  per Auto-Aktivierung noch per `/name`. Modified-Skills lösen einen
  Re-Confirm-Dialog aus, der die neuen `allowed-tools` gegen die
  zuletzt freigegebene Version vergleicht und neu hinzugefügte Tools
  rot markiert ("← neu"). Verhindert, dass ein Teammitglied
  nachträglich Tools zu einem vermeintlich sicheren Skill ergänzt,
  ohne dass der Nutzer es bemerkt.
- **Auto-Trust für Starter-Skills.** Beim Vendor-Schritt der drei
  mitgelieferten Skills (S6) wird der initiale Content-Hash direkt in
  den Trust-Store geschrieben, sodass der First-Run nicht von einem
  Freigabe-Dialog unterbrochen wird. Frisch im Editor angelegte
  Skills werden ebenfalls automatisch getrusted — der Nutzer hat sie
  selbst verfasst.
- **Neue IPC-Surface:** `window.api.skills.save(payload)`,
  `delete(name)`, `trust(name)` und `listAvailableTools()`.
  Trust-Store-Änderungen lösen ein `skills:changed`-Broadcast aus,
  damit die Settings-UI den Pill live updaten kann.
- **Neue Tests:** `pnpm test:skills:trust` (TrustStore-Round-Trip +
  Auto-Trust beim Vendor + End-to-End Loader-Reload nach
  trust()/Edit) und `pnpm test:skills:save` (pure
  `buildSkillFile`-Round-Trip + `saveSkillToDisk` + serverseitige
  Validierung). Beide laufen via `tsx` gegen den TS-Source, ohne den
  Electron-Lifecycle anzufassen.

## v0.1.124 — 2026-05-11

- **[PLAN §2 S3] Settings → Skills list UI + Toggle + Body-Viewer.**
  Neuer Abschnitt unter Einstellungen, der den vom Loader erkannten
  Skill-Bestand auflistet (Nutzer + Workspace), pro Skill einen
  Aktiv-Schalter bietet und den Markdown-Body in einem Modal anzeigt.
  Per-Nutzer-Status persistiert in `<userData>/skills-prefs.json` als
  `{ disabled: string[] }`; der Orchestrator filtert deaktivierte
  Skills sowohl aus dem System-Prompt-Block als auch aus der
  `/skill-name`-Auflösung und der Auto-Aktivierung.
- **Gate-Skills bleiben sichtbar.** Skills mit nicht erfüllten
  `metadata.ava.requires`-Bedingungen werden ab S3 NICHT mehr
  silent verworfen, sondern als `gateSatisfied: false` plus
  deutscher `gateReason` ("HubSpot ist nicht verbunden",
  "Ollama läuft nicht", …) im Loader behalten. Der Orchestrator
  überspringt sie weiterhin, aber die Settings-UI kann jetzt
  klar erklären, warum ein Skill inaktiv ist.
- **IPC.** Neue `window.api.skills.*`-Surface: `list()`,
  `getBody(name)`, `setEnabled(name, enabled)`, `reload()`,
  `openPath(target?)`, `onChanged(cb)`. Datei-Watcher feuert
  weiterhin den Store-Reload und broadcastet `skills:changed`,
  damit Edits ohne App-Neustart sichtbar werden.
- **Tests.** Neues `pnpm test:skills:prefs` deckt
  `SkillsPrefsStore` (Roundtrip + Persistenz + Event) sowie
  `SkillStore.get().body` und das neue Gate-Surface ab.

## v0.1.123 — 2026-05-11

- **[PLAN §2 S6] Drei Starter-Skills out-of-the-box.** Beim ersten
  Start kopiert `vendorBundledSkills()` die mitgelieferten Skills
  aus `resources/skills/<name>/SKILL.md` nach
  `<userData>/skills/<name>/SKILL.md` — no-overwrite, damit
  spätere Updates Nutzer-Edits nicht zerstören. Der Loader scannt
  danach wie gewohnt das User-Verzeichnis. Bundled:
  - `outreach-draft-de` (`b2b-scope: outreach`,
    `requires-user-confirm: true`, nur Read-Tools; der Nutzer
    versendet selbst aus dem eigenen Mail-Client).
  - `qualifying-fragebogen` (`b2b-scope: qualifying`,
    `requires-user-confirm: false`, BANT/MEDDIC-Fragebogen mit
    Empfehlungszeile am Ende).
  - `wettbewerber-uebersicht` (`b2b-scope: competitive`,
    vergleichende Tabelle plus kurze Einordnung; fragt nach
    Wettbewerber-Namen, falls keine übergeben wurden).
- **Packaging.** `electron-builder.yml` zieht `resources/skills/**`
  über `extraResources` in den Bundle (gleiches Muster wie für
  `resources/ollama` und `resources/whisper`). Pfad-Auflösung in
  `initSkills()`: dev = `app.getAppPath()/resources/skills`,
  packaged = `process.resourcesPath/skills`.
- **Smoke-Test.** Neues `pnpm test:skills:bundled` lädt die
  gebündelten Skills über den realen Loader und prüft Frontmatter,
  `b2b-scope` und Read-Tool-Charakter der Allowlist. Fängt
  Frontmatter-Regressions ab, wenn jemand eine bundled SKILL.md
  editiert.

## v0.1.122 — 2026-05-11

- **[PLAN §2 S2] Skills agent-integration landed.** The skills loaded in
  S1 are now wired into the chat agent.
  - **System-prompt block:** every turn appends a "Verfügbare Skills"
    list (name + b2b-scope + description) for skills with
    `disable-model-invocation: false`, plus the PLAN §2.4-rule-3
    out-of-scope refusal instruction whenever any skill is loaded.
  - **`/skill-name [args]` invocation:** the orchestrator detects a
    kebab-case slash command on the first line of a user message
    and injects the rendered body (with `$ARGUMENTS` and
    `${arg-name}` substitution) as an additional user-role message
    before the LLM is called.
  - **Enforced tool allowlist (the S2 acceptance criterion).** When a
    skill is active (explicit `/name` OR auto-activation), `runTool`
    checks `call.name` against `allowedTools` BEFORE invoking the
    tool. Empty list = pure-prose skill, refuse all tools. Non-empty
    list = refuse anything not in it. Refusals fold into the normal
    `ok: false` tool-result shape so the LLM sees the German refusal
    message and can adjust. Pure helpers live in
    `services/desktop/src/main/skills/allowlist.ts` and are covered
    by `pnpm -F @ava/desktop test:skills:agent`.
  - **Auto-activation:** a crude description-keyword overlap match
    against the last user message picks at most one skill per turn.
    Two distinct keyword hits (>= 4 chars) required; the skill with
    the most hits wins (first-loaded breaks ties).
    `disable-model-invocation` blocks auto-activation.
    TODO(S2-followup): semantic match.
  - **`metadata.ava.requires` gate evaluator** (replacing the S1
    "any-requires -> skip" placeholder). Recognises:
    `crm: hubspot | salesforce | dynamics | any` against
    `crmManager.getStatus(provider).connected`; `ollama: installed |
    running` against `ollamaSupervisor.getStatus()`. `tier:` is
    accepted but always satisfied (no tier system yet). Unknown keys
    log a German warn and treat the gate as satisfied. The evaluator
    is injected into `initSkills(app, { evaluateGate })` from
    `main/index.ts` so the skills module stays decoupled.
  - **Reload follow-up:** `SkillStore.reload()` re-evaluates gates,
    so a future `crmManager.on("status", () => skillStore.reload())`
    can be wired without touching the skills module. Not auto-wired
    in S2 — keep one moving part per release.
- New script: `pnpm -F @ava/desktop test:skills:agent` exercises the
  allowlist, slash parser, body renderer, auto-activation heuristic,
  and gate evaluator as pure functions (no LLM spin-up).
- Doc updates: `SKILLS.md` gains "Tool-Allowlist",
  "`metadata.ava.requires`", "`/skill-name`-Aufrufe", and
  "Auto-Aktivierung" sections.

## v0.1.121 — 2026-05-11

- **[PLAN §2 S1] Skills loader landed.** AVA now reads user-authored
  `SKILL.md` files at launch from `<userData>/skills/<name>/SKILL.md`
  and `<repo>/.ava/skills/<name>/SKILL.md` (workspace, only if the
  directory exists). New module: `services/desktop/src/main/skills/`
  (`schema.ts`, `parser.ts`, `loader.ts`, `store.ts`, `index.ts`).
  - **Schema (yup):** frontmatter contract from PLANS.md §2.3.
    Required: `name` (kebab-case), `description`, `b2b-scope`
    (enum: `outreach | qualifying | competitive | data-extraction
    | internal`). Optional with safe defaults: `language` (`de`),
    `allowed-tools` (`[]` — pure-prose skill, no tools fire),
    `requires-user-confirm` (`true`), `disable-model-invocation`
    (`false`), `user-invocable` (`true`), `arguments` (`[]`),
    `metadata.ava.requires` (gating block; S1 only parses + logs,
    S2 wires the evaluator).
  - **Parser:** YAML frontmatter (via the `yaml` lib) + markdown body.
  - **Loader:** discovers, validates, hashes (sha256 of raw bytes).
    Validation failures and unsatisfied gates are skip-loaded with a
    German `[skills] '<path>' übersprungen: …` log. Name conflicts
    resolve user-scope wins, with a warning.
  - **Store:** singleton `SkillStore extends EventEmitter` with
    `list()` / `get(name)` / `reload()`. Watches both skills dirs via
    `fs.watch({ recursive: true })` (200 ms debounce) so editing a
    `SKILL.md` hot-reloads without restarting AVA. No chokidar dep.
  - **Wired into `app.whenReady`** alongside the other supervisors.
    Logs `[skills] loaded N skills (M user, K workspace)` on init.
    No IPC / `window.api` surface yet — that lands in S3.
  - **Fixtures + smoke test:** six fixtures under
    `src/main/skills/__fixtures__/` (two valid, four invalid /
    gated). New `pnpm -F @ava/desktop test:skills` script invokes
    the loader through the workspace-hoisted `tsx` ESM loader and
    asserts the expected outcomes.
- **New dep:** `yaml ^2.x` in `services/desktop`. No other deps added.
- **Docs.** New `SKILLS.md` at the repo root: user-facing frontmatter
  reference + scope values + minimal example + trust-dialog note.
  `services/desktop/README.md` gets a "Skills" sub-section.

## v0.1.120 — 2026-05-11

- **[PLAN T1-T5] Tool-coverage audit landed.** The chat agent now
  exposes 92 tools across 19 files (up from 61), covering every IPC
  channel the UI uses. New tool families:
  - **T1 — LinkedIn + CRM-link family** (d9dfaa2): `linkedin_status`,
    `linkedin_connect`, `linkedin_disconnect`, `linkedin_scan_now`,
    `linkedin_cancel_run`, `crm_list_links_for_company`,
    `crm_fetch_details_raw`, `crm_enrich_now`,
    `crm_search_hubspot_companies`, `crm_link_manual`.
  - **T2 — Ollama / voice / updater** (95704be): `ollama_status`,
    `ollama_pull_model`, `ollama_restart`, `ollama_delete_model`,
    `voice_status`, `voice_install_binary`, `voice_download_model`,
    `voice_delete_model`, `updater_status`, `updater_check`,
    `updater_download`, `updater_install`.
  - **T3 — Reachability + producers + chat history** (857156b):
    `reachability_status`, `producer_status`, `producer_restart`,
    `producer_tail_logs`, `chat_history_search`, `chat_history_open`,
    `chat_history_delete`.
  - **T4 — CRM connect/disconnect UX polish** (51db0e2):
    `connect_crm`/`disconnect_crm` now share the canonical
    `CrmManager` path with Settings UI (always did), but error
    messages from Salesforce/Dynamics translate cleanly to German
    ("noch nicht freigeschaltet") and the system prompt nudges the
    agent toward `import_companies_from_crm` or `crm_link_manual`
    after a successful HubSpot connect.
  - **T5 — Auto-generated TOOLS.md.** `pnpm -F @ava/desktop tools:doc`
    walks `src/main/agent/tools/*.ts`, extracts `defineTool({...})`
    blocks via brace-balanced parsing, and writes a flat inventory
    at the repo root. `build:typecheck` runs the generator first so
    the doc rarely lags. Source of truth stays the TS files.

  All new tools are gated by the same `b2b-scope` enum + system-
  prompt guardrails the rest of the agent follows. The skills-system
  S-track (PLANS.md §2) is next.

## v0.1.119 — 2026-05-11

- **[WORKSTREAM C] C4 UI surface for CRM links + desktop-side
  HubSpot live enrichment fetcher.** Closes out the user-facing
  half of the CRM linkage feature whose backend shipped in v0.1.118.
  CompanyDetail Overview tab gains a new "CRM" panel: empty state
  ("Diese Firma ist mit keinem CRM verknüpft." + "Mit CRM verknüpfen"
  button); linked state shows per-CRM sub-cards with display name,
  provenance, last sync time, "Aktualisieren" button, "Im CRM
  öffnen" link, and a compact summary (`N Deals · M Kontakte ·
  letzte Aktivität vor X`) plus Top-Kontakte + Aktive Deals lists.
  Auto-fires the on-device fetcher when cache is empty.
  AllCompanies + TransactionDetail rows gain inline `HS` / `SF` /
  `MS` badges (batch-fetched via new `POST /v1/companies/crm-links/batch`
  to avoid N+1). Manual link picker modal pre-populates with the AVA
  company name and live-searches HubSpot's `/companies/search` API.
  New gateway routes: `POST /v1/companies/:id/crm/links` (manual
  link create/update) and `POST /v1/companies/crm-links/batch`
  (bulk link summary). New IPC surface: `window.api.crm.{listLinks,
  fetchDetails, enrich, searchHubspotCompanies, linkManually}`.
  Salesforce + Dynamics tabs in the picker are disabled with "noch
  nicht eingerichtet" placeholders.
- **Docs: `PLANS.md` published.** Living planning document with two
  workstreams: (1) tool-coverage audit identifying ~25 IPC channels
  reachable only via UI clicks (LinkedIn family, CRM family, Ollama,
  voice, updater, diagnostics) with a phased plan T1-T5 to expose
  them as chat-agent tools; (2) user-authored skills system modelled
  on the AgentSkills standard (Anthropic / OpenClaw) with
  AVA-specific guardrails for B2B-sales scope: enforced tool
  allowlist (not just pre-approval), `b2b-scope` enum frontmatter,
  out-of-scope hard refusal in the system prompt, no shell
  injection, trust dialog on import + re-confirm on disk-change,
  `metadata.ava.requires` for env/binary/tier gating, hot-reload
  watcher. Phased plan S1-S7 with three starter skills (Outreach
  Draft DE, Qualifying Fragebogen, Wettbewerber-Übersicht) shipped
  in S6 ahead of the editor UI to validate the model end-to-end.

## v0.1.118 — 2026-05-11

- **Heartbeat-driven auto-retry of failed producer cells.** Six new
  columns on `EntityProgress` track cumulative failure counts +
  backoff state: `attempts`, `firstFailureAt`, `lastFailureAt`,
  `nextRetryAt`, `giveUpAt`. `recordEntityProgress` atomically
  resets counters on completed/skipped and advances them on failed.
  Backoff per attempt N (slow producers — structured-content,
  company-publication, website): 5min/30min/2h/8h/24h. Fast
  producers (profile, contact, evaluation): 1min/5min/15min/1h/4h.
  After 5 attempts AND >24h since first failure, the row gets
  `giveUpAt` stamped and is taken off the auto-retry queue (manual
  retry still works). New `RetryTicker` in the desktop main process
  polls `GET /v1/transactions/retry-queue/pending` every 10 min,
  dispatches retries with 200-400ms stagger so the producer queues
  don't spike. Disabled by un-checking "Fehlgeschlagene Schritte
  automatisch erneut versuchen" in Settings → Meldungen, or by
  setting Heartbeat-Frequenz to 0. TransactionDetail cells now show
  a "Nx" badge after the second failure and a German retry-status
  line in the tooltip ("Wartet auf erneuten Versuch in 8 Min" /
  "Erneuter Versuch fällig" / "Aufgegeben nach 5 Versuchen").
  Triage order: lower `attempts` wins — a one-off hiccup gets
  retried fast, persistent failures are deprioritised so user
  attention isn't burned.
- **[WORKSTREAM C] CRM-to-AVA company linkage (C1+C2+C3).** New
  gateway tables `CompanyCrmLink` and `CompanyCrmCache` with
  `(tenantId, companyId, crmType)` unique key (HubSpot / Salesforce
  / Dynamics). Persist sites: HubSpot bulk import (exact match =
  `EXACT_MATCH`, ambiguous-then-confirmed = `USER_CONFIRMED`,
  unmatched-new = `EXACT_MATCH`); Excel import with typed headers
  (`hubspot_id` / `hs_object_id` / `salesforce_id` / `sfdc_id` /
  `sf_id` / `dynamics_id` / `msd_id` / `dataverse_id` / `d365_id`);
  `import_company` tool with explicit `crm` arg = `SINGLE_IMPORT`.
  Last-write-wins on conflict. Multi-CRM concurrent links per AVA
  company supported (one row per crmType). Read API:
  `GET /v1/companies/:id/crm` (cheap, DB only),
  `GET /v1/companies/:id/crm/details?refresh=false` (6h TTL cache;
  Salesforce/Dynamics return `notConfigured:true` stub).
  `POST /v1/companies/:id/crm/cache` is the desktop-side
  populate-cache endpoint for HubSpot enrichment (per-user OAuth
  tokens stay on-device). New chat-agent tool `company_crm_summary`
  wired into the open-question fan-out (cache-safe, no quota burn).
  Prompt teaches the agent to render "CRM-Kontext (HubSpot /
  Salesforce / Microsoft Dynamics)" subsections with deal count +
  contact count + last activity + top 2-3 contact names.
- **Stripe: in-place subscription upgrades (no more duplicate subs).**
  `/v1/billing/checkout` now detects an existing usable subscription
  (active, trialing, past_due, or active-with-cancel-at-period-end)
  and calls `stripe.subscriptions.update` with
  `proration_behavior:create_prorations` + clears
  `cancel_at_period_end` instead of minting a new subscription. Same
  Tier → 409 with "Du bist bereits auf diesem Tarif." The renderer
  skips `shell.openExternal` and fires the existing `billing:success`
  IPC so the usage snapshot refreshes immediately. Fixes the bug
  where subscribing to a higher tier after cancelling the lower one
  left both running in parallel until the period ended.
- **Gateway: `/companies/:id/profile` no longer 500s on column
  drift.** Pre-fix the route queried `"businessPurpose"` directly
  on `CompanyProfile` — that column lives on a joined
  `CompanyBusinessPurpose` table via `businessPurposeId` FK. Switched
  to LEFT JOIN; companies without a linked purpose return null
  unchanged. Also wrapped the `/contacts` handler in a try/catch
  that logs `err.message + stack` on anything that's not a planned
  HTTPException, so the next prod 500 surfaces a real reason in
  `fly logs`.
- **Contact producer: malformed socials no longer kill the whole
  compute.** `analyzePageWithOpenAI` was throwing
  `"company.socials[0].url is a required field"` whenever the LLM
  returned a bare host (`linkedin.com/foo`) or null URL. Schema
  relaxed to nullable; new `coerceSocialUrl` helper adds `https://`
  when scheme is missing, rejects strings without a real hostname,
  and silently drops unusable entries. Socials are enrichment, not
  load-bearing.

## v0.1.117 — 2026-05-11

- **Handelsregister: wait for the "Bitte warten Sie" overlay before
  clicking SI; JS-click fallback when click is intercepted.** The
  blocking JSF overlay that handelsregister.de shows during long
  post-back cycles was intercepting the SI click silently — Selenium
  found the link, `.click()` threw "element click intercepted", the
  retry loop quietly tried the next locator, and after ~12 minutes
  the slowest locator timed out with a generic
  `Could not click "SI" (Strukturierter Inhalt) link on result row`.
  Fix: new `waitForOverlayGone` polls for visible elements containing
  the German strings "Bitte warten Sie" or "Anfrage wird bearbeitet"
  AND for the PrimeFaces `.ui-blockui-content` pattern; called once
  before locating SI (xlong timeout), once at the top of each retry,
  and once more after the SI click to give the XML-prep round-trip
  time to finish before the Path A/C download poll starts. New
  `clickSafelyWithJsFallback` dispatches a real mousedown/mouseup/
  click sequence via `dispatchEvent` when the normal Selenium click
  trips the overlay-interception guard, and as a last resort sets
  `window.location.href` if the link didn't navigate on its own.
  Two extra permissive locators added to the SI-locator chain to
  cover `<a><span>SI</span></a>` nested-text markup variants.
- **Contact DB: relaxed the legacy `@@unique([personId, companyId,
  title, startDate])` Employment constraint.** The runtime
  reconciler in v0.1.116 keys upserts on `(personId, companyId)`
  only — the historical unique index occasionally forced the new
  upsert into a fallback branch when an existing row already had a
  sibling title for the same person+company. Schema updated;
  migration `20260511120000_relax_employment_unique` adds
  `DROP INDEX IF EXISTS "Employment_personId_companyId_title_startDate_key"`.
  Applied to prod `ava_company_contact` inside the same transaction
  that registered the migration in `_prisma_migrations`.
- **Contact DB: one-shot cleanup of legacy duplicates** (applied to
  prod simultaneously; commit log only, no schema change). Three
  atomic passes against `ava_company_contact`:
  - **Pass 1** collapsed 41 duplicate Employment rows across 27
    `(personId, companyId)` groups. Highest-confidence row wins;
    EmploymentSource rows reassigned to winner; `isCurrent=true`
    lifted from losers to winner when any loser was current.
  - **Pass 2** merged 1 duplicate Person (Joyce Marvin Rafflenbeul —
    newer dup merged into older canonical, FK rewrites for Fact /
    FactObservationLink / Observation / SignalEvent / Employment
    with conflict-safe delete-or-update semantics on the canonical
    side).
  - **Pass 1 redo** collapsed 1 additional Employment that surfaced
    post-merge.
  - **Pass 3** demoted 40 redundant ACTIVE Facts on `department`
    and `jobTitle` to INACTIVE across 30 `(personId, field)` groups.
  Final counts: Persons 99→98, Employments 140→98 (−30 %),
  EmploymentSource 367→367 (all reassigned, none lost), Active
  Facts 671→627.
- **db-gateway redeployed (v52, fra).** The v0.1.116 fixes that
  needed gateway code — `CompanyKeyword.normalizedKeyword` insert,
  retry-state `EntityProgress` writes — are now live in production.

## v0.1.116 — 2026-05-11

- **company-publication: FoxIO captcha solved by a deterministic
  Selenium click first; LLM kept as fallback.** The "Ich bin ein
  Mensch" widget on unternehmensregister.de loads its checkbox inside
  an iframe. The LLM agent's DOM snapshot was the parent document
  only, so it couldn't see the checkbox and gave up. Two changes:
  (a) `tryDeterministicFoxClick` walks the top document and every
  same-origin iframe, trying `#fox-captcha-checkbox`, generic
  `input[type=checkbox]`, label-text xpath, and case-folded text
  match — clicking the first hit. Cross-origin iframe access is
  caught and skipped; `defaultContent()` is restored on every exit
  path. On success the LLM is never invoked. (b) `snapshotDom` now
  recursively inlines same-origin iframe content between
  `<!--__AVA_IFRAME_BEGIN__ id=…-->` markers so the LLM fallback
  also has a chance, and the click executor falls back to an
  iframe-walk when a top-level selector misses.
- **company-contact: Employment dedup + LLM role canonicalisation.**
  The producer's `findFirst` keyed on `(personId, companyId, title,
  startDate)`, so any LLM-rephrase of the title between runs
  ("Vorstandsmitglied (Board member)" vs "Vorstandsmitglied (Board
  Member)") created a fresh Employment row, while the loop above
  marked the previous row `isCurrent=false` because its title didn't
  exactly match the new one — producing the observed "2 current + 1
  past, all same role" pattern. New behaviour: one Employment per
  `(personId, companyId)`, multiple sources accumulate as
  EmploymentSource rows. A new `canonicaliseEmploymentRole` LLM
  pass takes all observations for the person+company and returns a
  single canonical `{title, department, isCurrentlyEmployed,
  confidence, reasoning}`. Confidence merges as
  `max(existing, incoming, llm)` so it can't regress. `isCurrent`
  only mutates when the LLM is certain.
- **company-contact: Person dedup.** `personIdentityKey` now uses a
  proper URL canonicaliser (lowercased host + lowercased path, no
  trailing slash, no query, no fragment) so the same LinkedIn profile
  with different spellings collapses to one keyspace.
  `upsertPersonByIdentity` adds a fallback NFKD-normalized-fullName
  match scoped to the company, so a Person observed once via website
  (no URL → name-hash key) and once via Google (URL key) finds the
  existing row instead of minting a new one. The new identityKey is
  attached as an additional Fact on the existing Person.
- **company-contact: snippet provenance restored.** Every
  Observation row had `evidence: null` hardcoded, killing the audit
  trail. `EmployeeCandidate` gained an `evidence?: string` field;
  valueserp now copies `r.snippet` into the candidate (matched by
  link → name-in-snippet → joined LinkedIn-domain fallback, capped
  280 chars); the website_people path adds an `excerptForName(text,
  fullName, 500)` helper that returns a 500-char window of the page
  text around the matched name (or `undefined` when the name isn't
  present, no fabrication). `buildPersonObservations` plumbs this
  into the `evidence` column on `jobTitle`/`department`/
  `employmentCompanyId` observations (identity-typed fields stay
  null because a free-text snippet doesn't help audit them).
- **CompanyDetail PersonCard cleanup.** Cards used to dump every
  Fact row the producer emitted (3-6 ACTIVE + a tail of INACTIVE),
  with mixed status pills interleaved. Now ACTIVE rows are grouped
  by field — the highest-confidence row renders inline, sibling
  variants collapse into a `+N Varianten` toggle. INACTIVE rows move
  into a closed `<details>` "Historie (N)" disclosure. Inline status
  pills are gone (every visible row is ACTIVE by definition; the
  history is explicitly labelled).
- **Tier pill tooltip reactivity.** Replaced the native `title=""`
  popover (1.5 s hover delay, resets on jitter) with a CSS-driven
  tooltip that appears instantly on `:hover` / `:focus-within` and
  dismisses instantly on leave. `pointer-events: none` so the tooltip
  can't steal hover from the trigger.
- **Gateway: `CompanyKeyword` insert populates `normalizedKeyword`.**
  v0.1.106's keyword-persist path forgot to populate the NOT-NULL
  `normalizedKeyword` column, so every company-profile compute since
  has been crashing on persist. Now normalises via
  NFKD → strip combining marks → lowercase → collapse whitespace →
  trim, with dedup keyed on the normalized form. Gateway redeploy
  required to take effect (see `fly deploy -a ava-db-gateway`).
- **Diagnostics: "Logs kopieren" button.** Right-aligned pill in the
  Logs controls row. Three states with visual feedback: idle (copy
  icon + label), copied (check icon + "Kopiert" in aqua, 1.6 s),
  error (warning + "Fehlgeschlagen" in red, falls back to
  hidden-textarea + execCommand if `navigator.clipboard` is
  unavailable). Copies the currently visible lines (post filter +
  stderr-only) as `ISO-timestamp [OUT|ERR] <line>` so the user can
  paste into a bug report without losing context.
- **TS hygiene.** Pre-existing implicit-any `ack` parameters in
  `company-profile-transaction-handler.ts`,
  `company-publication-transaction-handler.ts`, and
  `upsert-company-publication-handler.ts` got annotated as a side
  effect of the contact + publication patches. Producer builds are
  now clean.

## v0.1.115 — 2026-05-11

- **Handelsregister: capture SI XML when Chrome native-downloads it.**
  Some handelsregister.de deployments serve the SI link with
  `Content-Disposition: attachment` instead of opening a new tab or
  exposing an interceptable URL, so the file lands in Chrome's
  download dir and the prior Path A / Path B sniffers both missed it
  with "no new tab, no rp-download URL". `di.ts` now pre-configures
  Chrome to download into `AVA_HR_DOWNLOAD_DIR` (defaults to a
  tmpdir-scoped folder) with no prompt + safe-browsing disabled for
  XML. The webdriver snapshots the dir before the SI click and a new
  Path C polls for a new `.xml` that has no `.crdownload` sibling and
  has been stable ≥ 200 ms, picks the most recent, reads it, unlinks
  it. Path B kept as last-resort fallback. New `hr_06_after_download`
  screenshot fires after the click so we have a frame to inspect
  when nothing appears.
- **Matrix cell no longer sticks red during a running retry.** The
  retry endpoint already broadcast an optimistic `in_progress` SSE
  event, but never persisted it — a snapshot fetch on remount kept
  reading the prior run's `failed` row and the dot reverted to red
  even while the producer was still scraping. Retry handler now also
  upserts `EntityProgress` to `in_progress`, conditionally so it
  never overwrites a fresher state from the producer at handler
  entry.
- **Diagnostics Logs tab no longer appears empty on remount.** The
  log filter input defaulted to the runId, which silently hid every
  Selenium/Chromium internal line that didn't carry the runId
  substring. Filter starts empty now; the runId moves to the input
  placeholder as a copy-paste hint.
- **LinkedIn scan no longer freezes the UI.** Three blocking-IO
  sources converted from sync to async: 15× screenshot PNG writes
  per scan (each 100 KB–2 MB), the periodic `run.json` rewrite
  (~3 per scan), the up-to-2 MB feed-HTML dump, and the media
  downloads. Each capture call now also yields to the event loop
  via `setImmediate` so renderer IPC queued behind the await
  actually runs. Combined, this removes 15–20 main-thread stalls per
  scan that totalled ~1–3 seconds of UI freeze on macOS.
- **LinkedIn: auto-open the login window when a session expires
  mid-scan.** A manual scan returning `outcome: "login_required"`
  now fires the same handler the "Verbindung erneuern" /
  "Mit LinkedIn verbinden" buttons use, so the LinkedIn login window
  pops up immediately after the error banner instead of making the
  user hunt for a button. Guarded against double-firing via the
  existing `loginInFlight` state. Banner copy updated to match:
  „LinkedIn-Sitzung abgelaufen. Anmeldefenster wird geöffnet …".
- **LinkedIn open-link modal: drop the filler opening sentence.**
  "Bevor wir den Link öffnen, ein kurzer Hinweis." removed; the
  paragraph now leads directly with the LinkedIn-flagging warning.
- **Stammkapital displayed at correct magnitude.** Postgres
  `NUMERIC(_,3)` columns serialize via node-pg as strings like
  `"37500.000"`, which the renderer's `numVal()` was treating as
  German thousands notation — turning 37.500 € into 37.500.000 €.
  The thousands-vs-decimal heuristic is tightened so only strict
  `\d{1,3}(\.\d{3})+` groups are collapsed; trailing `.000` decimal
  scale is preserved as a decimal point. Affects every money
  formatter that goes through `numVal()`.

## v0.1.114 — 2026-05-11

- **LinkedIn: Sponsored/Promoted posts dropped at the source.** Extractor
  now bails out after detecting `feedSlot === "promoted"`, so ads never
  reach the LLM, the DB, or the signals UI. The `candidateCounts.promoted`
  diagnostic still increments so we can confirm the filter is firing.
- **LinkedIn: one-shot purge of legacy Sponsored rows.** Idempotent
  DELETE chain in `SCHEMA_SQL` drops `linkedin_post` rows whose author
  is a company actor with the `"Unbekannt"` fallback display name (the
  exact signature of sponsored ads that landed before the v0.1.113
  filter). Cascades through `linkedin_signal` / `linkedin_interaction`
  / `linkedin_media`. Runs every boot but is a no-op once cleaned.
- **LinkedIn: actor names recovered from avatar markup.** Posts often
  rendered as "Unbekannt" because the actor anchor list contained both
  the avatar `<a>` (figure only, no text) and a separate info `<a>`
  with the same `href`. New `dedupeByHref()` picks the anchor with the
  richest text content per href, and an `img[alt]` / `svg[aria-label]`
  fallback parses the common `"View <Name>'s profile"` / `"Foto von
  <Name> anzeigen"` patterns before defaulting to `"Unbekannt"`.
- **LinkedIn: confirmation modal before opening any link.** Clicking
  the author name or "Auf LinkedIn öffnen" now opens a German-language
  consent modal explaining that programmatic-style navigation can
  occasionally raise LinkedIn account safety flags and recommending
  moderate, deliberate use. Session-only "Hinweis nicht mehr anzeigen"
  checkbox suppresses the modal for the rest of the session
  (sessionStorage, not localStorage).
- **Handelsregister: PrimeFaces selectOneMenu detection.** The scraper
  threw "Registergericht select not found" because handelsregister.de
  wraps native `<select>` in `ui-helper-hidden-accessible` (sr-only),
  failing `isDisplayed()`. `waitVisible` swapped for `waitPresent` and
  `selectByVisibleText` rewritten with three strategies: native select
  via JS `dispatchEvent('change')`, PrimeFaces widget click flow
  (trigger → panel item), keyboard fallback for autocompletes. Adds a
  `hr_02b_form_visible` screenshot right after the form renders.
- **Per-runId screenshot cleanup on restart.** Both `structured-content`
  and `company-publication` producers now `fs.rm` the per-runId
  screenshot directory in `setCurrentRunId(runId)`, so retries /
  re-imports start from a clean directory and the matrix drill-down
  only shows frames from the current attempt.
- **Diagnostics tabs wrap to a second row.** Logs/Screenshots buttons
  no longer overflow the producer dropdown to the right in narrow
  drill panels.

## v0.1.113 — 2026-05-10

- **LinkedIn-Beobachter: rewrite for the obfuscated-class DOM.**
  v0.1.112's broadened selector list ran against a DOM dump and matched
  exactly nothing: LinkedIn dropped `data-urn` from feed wrappers and
  now ships hash-suffixed per-build CSS classes (`_3198bc31`,
  `_9cb66104`, ...). The selectors that survive are role / componentkey
  / data-testid attributes. This release:
  - Replaces the 12-candidate wrapper list with a single primary
    selector — `div[role="listitem"][componentkey^="expanded"][componentkey*="FeedType_"]`
    — plus a sentinel check on `h2 span` containing "Feed post" so
    composer cards, "Advertise on LinkedIn" promo cards, and the
    "Letters" / suggestion carousel get skipped.
  - Extracts a stable `postKey` (no `urn:li:` prefix) from the wrapper's
    `componentkey` attribute via
    `/^expanded(.+?)FeedType_[A-Z_]+$/`. Example componentkey
    `expandedScdd...xWQFeedType_MAIN_FEED_RELEVANCE` yields postKey
    `Scdd...xWQ`. **Schema rename**: this value still rides in the
    existing `postUrn` field (DB column `post_urn` is unchanged) but is
    additionally exposed as a sibling `postKey` alias for one release.
    Downstream code that reads `postUrn` keeps working; new readers
    should migrate to `postKey`.
  - Body text uses
    `p[componentkey^="feed-commentary_"] span[data-testid="expandable-text-box"]`
    and strips the trailing "…more" / "…mehr anzeigen" button text.
  - Actor link comes from `a[href*="/in/"]` or `a[href*="/company/"]`,
    with first-vs-second-link logic for repost / attribution headers
    ("X commented on this", "Y likes this", "Z reposted this", "follow")
    so the real post author is picked, not the attributor.
  - Permalink **may now be null** — most `<a href>` inside the new
    feed DOM point at the placeholder `/feed/` href because LinkedIn
    keeps the real URL in React state. Existing downstream types
    already tolerate `string | null`. The "Letzte Signale" UI falls
    back to the actor's profile URL when the row has no permalink (no
    more synthetic `/feed/update/<urn>/` URLs — those would 404 with a
    postKey).
  - New record fields: `feedSlot` (`"feed"` | `"suggested"` |
    `"promoted"`) and `attribution` (the verb + actor of an "X
    commented on this" header, or null).
  - Diagnostic `extractionDiagnostic.candidateCounts` in `run.json` is
    re-keyed to match the new pipeline: `wrapper`,
    `wrapper_with_sentinel`, `body_text_found`, `actor_link_found`,
    `image_found`, `document_found`, `promoted`, `suggested`.
    `finalCount` keeps its meaning — posts that passed all required-
    field checks.
  - Required-field policy relaxed for promoted and document-heavy
    posts that lack a body: a post is accepted when postKey is
    non-empty AND it has body text OR an image OR a document carousel
    OR a video.
  - If a fresh scrape still shows `postsSeen: 0`, users should send the
    new `<runDir>/05_feed_html.html` plus `run.json` — the diagnostic
    now reports the new candidate keys.

## v0.1.112 — 2026-05-10

- **LinkedIn-Beobachter: extraction selector refresh.** v0.1.110
  anti-detection let the real feed render, but `postsSeen` stayed at
  zero — LinkedIn had shipped a DOM/class rename and the three
  hard-coded post-wrapper selectors no longer matched. This release:
  - Broadens the post-wrapper match list to 12 candidates covering
    `article` / `li` / `div` wrappers, the newer `data-id="urn:..."`
    attribute, and class-only fallbacks (`.feed-shared-update-v2`,
    `.update-components-update-v2`, `.feed-update-v2`). The URN is
    resolved from `data-urn`, `data-id`, a nested `[data-urn]`, or
    finally parsed out of a `/feed/update/<urn>/` permalink.
  - Hedges every per-post sub-selector (actor scope, body, sub-line,
    article link, permalink) against a candidate list and returns the
    first non-null match.
  - Dumps the feed container's `outerHTML` (capped at 2 MB) to
    `<runDir>/05_feed_html.html` right before extraction, mirroring
    the existing best-effort screenshot pattern, so selector drift
    can be diagnosed offline from the run folder alone.
  - Logs a `candidateCounts` / `finalCount` diagnostic via the
    existing `console.info` channel and stashes the same object in
    `run.json` under a new optional `extractionDiagnostic` field
    (`LinkedInRunMeta` updated accordingly).
  Downstream extractor shape (`postUrn`, `author`, `mediaUrls`, …)
  is unchanged; only which selectors find each field was relaxed.

## v0.1.111 — 2026-05-10

- **handelsregister.de scraper: JSF sidebar navigation.** The direct
  URL `https://www.handelsregister.de/rp_web/erweiterte-suche.xhtml`
  now returns HTTP 400 with a German security-session-end page, so
  every handelsregister scrape was failing at step 2 of the flow.
  The fix routes through the real navigation path:
  1. Land on `welcome.xhtml`, dismiss the cookie banner.
  2. Open the PrimeFaces sidebar via `#topbar-menu-button` if the
     "Erweiterte Suche" link is not already visible (the sidebar
     auto-opens on some loads, so we probe first).
  3. Click the link, selected by `//a[contains(@onclick,
     'erweiterteSucheLink')]` (XPath against the stable JSF param
     value), with visible-text and `j_idt46` id fallbacks.
  4. Wait for the `Registergericht` select to render — the JSF
     post-back leaves the URL as `welcome.xhtml`, so URL is not a
     usable readiness signal.
  Form filling, results-row SI click, and XML capture are unchanged.
  Submodule branch: `fix/handelsregister-sidebar-nav-v0.1.111` in
  `structured-content`, pinned via the desktop bundle.

## v0.1.110 — 2026-05-10

- **LinkedIn-Beobachter: anti-fingerprint hardening.** Earlier runs
  hit a session kill mid-hydration: cookies passed the auth check, but
  LinkedIn detected the headless-Electron fingerprint and re-rendered
  the feed as the anonymous marketing page. This release closes six
  classic detection holes.
  - Hidden `show: false` window replaced with a visible, transparent,
    off-screen window (`x/y = -2000`, `setOpacity(0)`, `skipTaskbar`,
    `frame: false`). Real outer dimensions, real paint, invisible to
    the user. Set `AVA_LINKEDIN_DEBUG_WINDOW=1` to show the window
    normally for inspection.
  - `navigator.userAgentData` now returns Chrome-124 brands (no
    "Electron" / "HeadlessChrome"), with a matching high-entropy
    payload and `platform: "macOS"`. `navigator.platform`,
    `hardwareConcurrency`, `deviceMemory`, `screen.*` and
    `window.outer*` are all pinned to plausible Mac values.
  - Stealth overrides are re-injected on every `did-start-navigation`
    and `dom-ready`, not just once on the initial `about:blank`, so
    LinkedIn's in-app route changes never see a clean prototype.
  - Scroll loop is fully `sendInputEvent`-based. The previous JS
    `window.scrollBy` fallback is removed; if the wheel event fails
    we skip the cycle rather than emit an untrusted scroll. Wheel
    delta jitters between 500-850px, with an extra 400-1200ms random
    delay between cycles and a 30% chance of a pre-scroll mouseMove.
  - Pre-scroll human warmup: 2-4s wait, two mouseMoves, one small
    wheel nudge, then another second before the main scroll loop
    starts.

## v0.1.109 — 2026-05-10

- **LinkedIn-Beobachter: per-run screenshot capture.** Each scrape now
  drops a timestamped folder under `userData/linkedin/runs/` with PNG
  shots at every checkpoint (initial nav, auth check, feed loaded, each
  scroll cycle, before extraction, error) plus a `run.json` sidecar
  with outcome, postsSeen, url and userAgent. Retention is capped at
  the last 10 runs; older folders are pruned on each new run.
  Screenshot capture is best-effort and cannot break the scrape.
  Settings panel gains a "Letzte Läufe" fieldset listing the most
  recent runs with an "Ordner öffnen" button each. Debugging-
  transparency only; scrape logic is unchanged.

## v0.1.108 — 2026-05-10

- **Chat bubble.** User message bubble flipped from indigo→violet gradient to
  flat `#0a3d36` deep teal. Contrast with white text is ~10.5:1, passes
  WCAG AAA (4.5:1 required for AA, 7:1 for AAA on normal text). No gradient.

## v0.1.107 — 2026-05-10

- **Chat agent: proactive re-import on data gaps.** When the company fan-out
  shows the company exists in master-data (`company_get` hit) but 3 or more
  content facets come back empty / 404 / 500 (profile, keywords, website,
  publications, contacts, structured-content), the agent now calls
  `import_company` unprompted with the name + city pulled from the
  `company_get` result. Previously the agent narrated the gaps in prose and
  waited for the user to ask. Idempotency: the rule does not re-fire if an
  import for that company already ran earlier in the same chat.

## v0.1.106 — 2026-05-10

- **Keywords persist fix.** `company-profile` producer now calls
  `getCompanyKeywords` alongside `getCompanyProfile`, includes the result in
  the persist payload, and emits the `companyEvaluation.upsertKeywords`
  downstream event. Gateway `applyCompanyProfile` does a transactional
  delete-then-insert into `CompanyKeyword` (zod-validated). Before this fix
  the company-profile cell turned green in the matrix but the
  `CompanyKeyword` table stayed empty.
- **Evaluation pending fix (derived cell).** `companyEvaluation` is now
  derived in the matrix read path from its upstream set
  `{structuredContent, companyPublication, website, companyProfile, companyContact}`:
  any upstream `in_progress` → `in_progress`; all upstreams terminal with
  at least one `completed` → `completed`; all upstreams terminal with none
  completed → `skipped`; otherwise `pending`. Sidesteps the pre-seeded
  `pending` row that never got overwritten when the v0.1.80 progress-signal
  cleanup removed per-slice `in_progress` publishes.

## v0.1.105 — 2026-05-10

- **Multi-source reachability monitor.** The single-service upstream probe
  expanded to an array of probed services with per-service hysteresis
  (`FAILED_PROBES_THRESHOLD=2`), 5-minute fast-path cooldown, 405-tolerance,
  and a 120-second probe cadence. Today probes `unternehmensregister.de`
  and `handelsregister.de`. Whoami got an "Erreichbarkeit der Quellen"
  panel showing per-service state + last-checked timestamps.
- **Dynamic upstream banner.** Banner hides when all sources reachable;
  lists each unreachable service with a fallback hint when only some are
  down; signals producer-paused state when all are down. Dismiss-suppress
  is keyed by signature, so a future combination of outages isn't silently
  muted by a prior dismissal.
- **Handelsregister.de fallback for structured-content.** New
  `handelsregister-webdriver.ts` in the structured-content submodule:
  cookie dismiss → erweiterte Suche form fill → SI link click → XML
  capture (handles both inline-render and download-attachment branches via
  perf-log + `node-fetch` with session cookies). XML output is identical
  in shape to unternehmensregister, so no DB schema change. The producer
  picks the source at each spawn via `AVA_STRUCTURED_CONTENT_SOURCE`, set
  by `pickStructuredContentSource()` in main; preference is
  handelsregister → unternehmensregister.
- **Auto-pause widened.** Structured-content producer only auto-pauses when
  **both** upstreams are down. Company-publication still pauses on
  unternehmensregister-down alone (no fallback there yet).

## v0.1.104 — 2026-05-09

- Per-tab tier pills on the company detail page (replaces the prominent
  Datenqualität top banner).
- Sidebar collapsed icon stack polish.

## v0.1.103 — 2026-05-09

- Stripe `cancel_at_period_end` surfaced in Settings as
  „Kündigung zum X vorgemerkt", with a helper to take it back. Webhook
  captures the flag on `subscription.updated`.

## v0.1.102 — 2026-05-09

- Reachability banner triggers less eagerly: 120s probe interval, two
  consecutive failures required, 5-minute cooldown on fast-path probes
  triggered by producer error reports, 405 tolerated as a reachable
  signal.

## v0.1.101 — 2026-05-09

- Plan & Abrechnung redesigned with 4-up comparison cards + tier-aware
  CTAs. „Empfohlen" badge on the Pro tier. „Abonnement verwalten" hidden
  for free users (would otherwise 400 against the portal).

## v0.1.99 — 2026-05-08

- CI vendor bug fix: the `prepare: tsc` lifecycle in vendored producer
  `package.json` was rebuilding `dist/` from stale committed `src/` on
  every `npm install`, silently wiping `getCurrentTier` / `getCurrentModel`
  exports. The fix strips `prepare` / `postinstall` / `preinstall` /
  `install` from staged vendor `package.json` before npm install runs.
  Release workflow no longer swallows producer build failures with
  `|| echo skipped`.

## v0.1.91 → v0.1.98 — LinkedIn-Beobachter (L0 → L7)

Opt-in LinkedIn feed beobachtung over 8 phases. Hidden Electron
`BrowserWindow` on `persist:linkedin` partition; `safeStorage`-encrypted
cookies; vision-LLM image analysis; entity linking against master-data;
heartbeat polling; surfaced via `/linkedin` route with filter bar +
signal cards + lightbox. Anti-detection hardening in L7.

## v0.1.75 — 2026-05-06

- Restored the `@theme {` opener in `styles.css` that v0.1.68 silently
  dropped. v0.1.69 → v0.1.74 had CSS tokens floating outside any block,
  Tailwind parser failing in CI, every release silently broken for seven
  bumps because `build:typecheck` doesn't compile CSS. Open follow-up:
  wire the renderer build into `build:typecheck` so this fails locally.
