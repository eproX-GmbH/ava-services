# AVA Agent-Tools

Auto-generiert von `services/desktop/scripts/generate-tools-md.mjs`.
NICHT direkt bearbeiten — die Quelle der Wahrheit ist `services/desktop/src/main/agent/tools/*.ts`.
Lauf via `pnpm -F @ava/desktop tools:doc` (oder automatisch via `build:typecheck`).

Stand: 2026-05-11
Anzahl Tools: 73

## Firmen (11)

### `company_contacts`

_Datei:_ `services/desktop/src/main/agent/tools/companies.ts`

Get the contact aggregate for a company (board members, generic emails, phone numbers).

_Parameter:_
- `companyId: string` (required)

### `company_crm_summary`

_Datei:_ `services/desktop/src/main/agent/tools/companies.ts`

Pulls CRM-side context for an AVA company: open deals, recent contacts, last activity. Use this when the user asks for an overview / status of a specific company they've imported from a CRM (HubSpot today). Returns empty when the company has no CRM link. Cheap to call when cached (no CRM API hit for up to 6h); safe to include in the default fan-out for open company questions without burning quota.

_Parameter:_
- `companyId: string` (required) — AVA master-data companyId.
- `refresh: boolean` — Force a fresh CRM-side fetch even if a cached payload < 6h old exists. Default false.

### `company_data_quality`

_Datei:_ `services/desktop/src/main/agent/tools/companies.ts`

Get per-stage LLM provenance for a company: which model produced each cell, what tier (S/A/B/C reliability), and when. Use this to qualify your answer when the user asks about company facts — soft-warn on tier-B/C sources, especially Tier C (small local models can hallucinate).

_Parameter:_
- `companyId: string` (required)

### `company_get`

_Datei:_ `services/desktop/src/main/agent/tools/companies.ts`

Fetch the canonical German-company record (legal name, register, address, industry codes) by its global companyId.

_Parameter:_
- `companyId: string` (required)

### `company_keywords`

_Datei:_ `services/desktop/src/main/agent/tools/companies.ts`

List extracted keywords/tags for a company (industries, products, themes).

_Parameter:_
- `companyId: string` (required)

### `company_linkedin_signals`

_Datei:_ `services/desktop/src/main/agent/tools/companies.ts`

Liefert die letzten LinkedIn-Signale für eine Firma. Zeigt Beitrag, Signal-Art, Stärke, gematchte Personen und kurze Zusammenfassung. Nutze das Tool, wenn der Nutzer fragt 'was tut sich bei <Firma> auf LinkedIn?' oder eine Status-Übersicht möchte.

_Parameter:_
- `companyId: string` (required)
- `limit: integer` (default: 10) — Max signals to return.

### `company_profile`

_Datei:_ `services/desktop/src/main/agent/tools/companies.ts`

Get the LLM-derived profile for a company (corporate purpose, summary, headcount, market positioning).

_Parameter:_
- `companyId: string` (required)

### `company_publications`

_Datei:_ `services/desktop/src/main/agent/tools/companies.ts`

List financial publications (annual reports etc.) for a company. Each item carries year, KPIs, and stateOfAffairs narrative.

_Parameter:_
- `companyId: string` (required)

### `company_search`

_Datei:_ `services/desktop/src/main/agent/tools/companies.ts`

Fuzzy-search German companies by name. Returns up to `limit` candidate matches (id, name, location). Use this first when the user mentions a company by name.

_Parameter:_
- `q: string` (required) — Company name (partial OK).
- `limit: integer` (default: 10) — Max matches to return.

### `company_structured_content`

_Datei:_ `services/desktop/src/main/agent/tools/companies.ts`

Get extracted structured content (facts, observations, signals) the cascade has stored for a company.

_Parameter:_
- `companyId: string` (required)

### `company_website`

_Datei:_ `services/desktop/src/main/agent/tools/companies.ts`

Get the crawled website summary for a company (homepage URL, scraped sections, last crawl).

_Parameter:_
- `companyId: string` (required)

## Importe (5)

### `import_companies_from_crm`

_Datei:_ `services/desktop/src/main/agent/tools/imports.ts`

Import companies from the user's CONNECTED CRM (HubSpot, Salesforce, or Microsoft Dynamics 365) and start one transaction with the full master- data pipeline. Use when the user says "importiere alle Firmen aus HubSpot", "start a run for everyone in our CRM", "alles aus dem CRM", etc. Today only HubSpot is wired end-to-end; if the user picks Salesforce or Dynamics this returns a clear 'not yet implemented' message — fall back to suggesting HubSpot or a file upload. Always check `crm_status` first if you're unsure which CRM is connected. Returns a transactionId you can hand back; progress checkable via `import_status`.

_Parameter:_ keine.

### `import_company`

_Datei:_ `services/desktop/src/main/agent/tools/imports.ts`

Ingest a single company by name + city, kicking off the full master-data pipeline (profile, website, publications, contacts, evaluations). Use this when the user asks to add or research one specific company they haven't attached a spreadsheet for (e.g. "Leg mir Foo GmbH aus Berlin an", "add ACME from Munich and find their data"). For multiple companies from a spreadsheet, use `import_excel` instead. Set `dryRun: true` to preview what master-data would match WITHOUT starting a transaction — the response then has shape `{dryRun: true, matched, unmatched: [{candidates: [...]}]}` so you can confirm the match with the user (especially when the company is uncertain) before committing. Otherwise returns a transactionId you can hand back; progress is checkable via `import_status`.

_Parameter:_ keine.

### `import_excel`

_Datei:_ `services/desktop/src/main/agent/tools/imports.ts`

Start a background bulk import for a spreadsheet the user has attached. Use this whenever the user wants to process every row of an attachment ("import this", "Durchlauf starten", "process all rows", "alle Firmen anlegen"). Do NOT iterate `company_search` over rows for this — that's slow, wasteful, and skips the master-data pipeline (profile, website, contacts, evaluations are auto-fanned out by the importer). You must have already confirmed the column mapping with the user (via `ask_user_choice` or by stating the inferred mapping and getting a 'go'). Returns a `transactionId` you can hand back to the user; they can watch progress in the Transactions view.

_Parameter:_ keine.

### `import_status`

_Datei:_ `services/desktop/src/main/agent/tools/imports.ts`

Quick progress snapshot for an import (or any transaction). Returns per-state counts (pending / in_progress / completed / failed / skipped) plus up to 5 failure messages. Prefer this over `transaction_pipeline` when the user asks 'how far is it?', 'wie weit ist der Import?', 'is it done?' — pipeline is heavier and stage-level. If the user just imported a file in this conversation, the transactionId is in the previous `import_excel` tool result; use that.

_Parameter:_
- `transactionId: string` (required) — The transactionId returned by `import_excel` (or any other transaction kick-off).

### `retry_stage`

_Datei:_ `services/desktop/src/main/agent/tools/imports.ts`

Re-run a single processing stage for one company inside an existing transaction. Useful when one stage failed (e.g. website crawl timed out, evaluation LLM errored) but the rest of the pipeline ran. The user usually phrases this as "retry the website for ACME", "run the contact scrape again for company X", "den Profil-Schritt nochmal laufen lassen". You need both the transactionId and the companyId — look them up via `transaction_entities` or `import_status` first if the user only named the company.

_Parameter:_
- `transactionId: string` (required)
- `companyId: string` (required)
- `stage: string (enum: structuredContent, companyPublication, website, companyProfile, companyContact, companyEvaluation)` (required) — Which stage to re-run. `companyEvaluation` fans out across all 5 evaluation producers in parallel.
- `companyName: string` — Optional — some upstream stages re-resolve by name (helps when the row's stored name had a typo).

## Transaktionen (5)

### `transaction_entities`

_Datei:_ `services/desktop/src/main/agent/tools/transactions.ts`

List per-company state for a transaction: which companies are running, done, or errored.

_Parameter:_
- `transactionId: string` (required)

### `transaction_errors`

_Datei:_ `services/desktop/src/main/agent/tools/transactions.ts`

List processing errors for a transaction. Use to answer 'what failed?'.

_Parameter:_
- `transactionId: string` (required)

### `transaction_get`

_Datei:_ `services/desktop/src/main/agent/tools/transactions.ts`

Get one transaction by id (status, counts, started/finished timestamps).

_Parameter:_
- `transactionId: string` (required)

### `transaction_pipeline`

_Datei:_ `services/desktop/src/main/agent/tools/transactions.ts`

Get the per-company × per-stage state matrix for a transaction. Each row carries `companyId` AND `companyName` so you can refer to companies by name in your reply without a separate lookup. The top-level `companies` map gives the same id→name dictionary for convenience. Heavy payload — only call when the user asks for stage-level detail.

_Parameter:_
- `transactionId: string` (required)

### `transactions_list`

_Datei:_ `services/desktop/src/main/agent/tools/transactions.ts`

List the user's recent processing transactions (ingest runs). Paginated. Use for 'what's running?' or 'show my last imports'.

_Parameter:_
- `page: integer` (default: 1)
- `pageSize: integer` (default: 20)

## Bewertungen (5)

### `evaluation_best_match_get`

_Datei:_ `services/desktop/src/main/agent/tools/evaluations.ts`

Get a best-match job's full result (ranked candidates with scores).

_Parameter:_
- `bestMatchId: string` (required)

### `evaluation_best_matches_list`

_Datei:_ `services/desktop/src/main/agent/tools/evaluations.ts`

List best-match jobs the user has run for a transaction (W15). Each item carries the comparison configuration and final ranking job id.

_Parameter:_
- `transactionId: string` (required)
- `page: integer` (default: 1)
- `pageSize: integer` (default: 20)

### `evaluation_comparison_get`

_Datei:_ `services/desktop/src/main/agent/tools/evaluations.ts`

Get a head-to-head comparison result between companies (W22).

_Parameter:_
- `comparisonId: string` (required)

### `evaluation_offer_analysis`

_Datei:_ `services/desktop/src/main/agent/tools/evaluations.ts`

Global semantic search across the ENTIRE company corpus (no transaction binding) for matches against a free-form offer / Ausschreibung. Faster than a per-transaction deep research — vector similarity + LLM ranking, no per-company evaluation. Use as the DEFAULT path when the user describes an offer / need / Lieferantensuche without naming a specific Vorgang. Returns a `bestMatchJobId` (the same shape `evaluation_start_best_match` returns); poll `evaluation_best_match_get` to read the ranked result. Typical wall-clock: 30–90 s for a small corpus, longer for thousands of companies.

_Parameter:_ keine.

### `evaluation_start_best_match`

_Datei:_ `services/desktop/src/main/agent/tools/evaluations.ts`

Start a per-transaction DEEP RESEARCH best-match job. Picks the top candidates among the companies inside one Vorgang (every row gets a full LLM evaluation, much slower than `evaluation_offer_analysis` but with richer per-company rationale). Use when the user explicitly scopes to a transaction ('in diesem Vorgang', 'in der letzten Transaktion', 'unter diesen Importen') OR when the user picked the deep-research option after the scope disambiguation. Requires the transaction to contain ≥2 companies. Returns a `bestMatchJobId`; poll `evaluation_best_match_get` for the ranked result. Typical wall-clock: 2–5 min depending on company count.

_Parameter:_ keine.

## Meldungen / Alerts (7)

### `alerts_dismiss`

_Datei:_ `services/desktop/src/main/agent/tools/alerts.ts`

Dismiss (delete from view) a single alert by id. The id comes from `alerts_list`. The row stays on disk for audit but is never shown again. Use when the user names a specific alert.

_Parameter:_
- `id: string` (required) — Alert id from `alerts_list[].id`.

### `alerts_dismiss_all`

_Datei:_ `services/desktop/src/main/agent/tools/alerts.ts`

Dismiss EVERY currently-visible alert in one shot. Use when the user says 'lösche alle Meldungen', 'clear all alerts', 'verwerfe alles'. Returns the number of rows touched. Irreversible from the user's perspective; the rows remain on disk for audit.

_Parameter:_ keine.

### `alerts_get_prefs`

_Datei:_ `services/desktop/src/main/agent/tools/alerts.ts`

Read the current heartbeat / push preferences (cadence, push toggle, severity threshold, quiet hours). Call this before `alerts_set_prefs` if you're unsure of the current state.

_Parameter:_ keine.

### `alerts_list`

_Datei:_ `services/desktop/src/main/agent/tools/alerts.ts`

List current heartbeat alerts (newest first). Use when the user asks 'welche Meldungen gibt es', 'was ist neu', 'zeig mir die letzten Alarme'. Optional `unreadOnly` filters to entries the user hasn't seen; `limit` defaults to 20.

_Parameter:_
- `unreadOnly: boolean` — When true, only return entries with seenAt=null.
- `limit: integer` — Max entries to return. Default 20.

### `alerts_purge`

_Datei:_ `services/desktop/src/main/agent/tools/alerts.ts`

Hard-delete heartbeat alerts from disk so the dedup index forgets them and the next heartbeat tick can re-evaluate the same candidates from scratch. Use when the user says things like 'lösche endgültig', 'wirklich löschen', 'retrigger alle Meldungen', 'frische Bewertung', 'wipe alerts', 'reset', or when `alerts_dismiss_all` returned `dismissed: 0` because everything is already soft-dismissed and the user expected an actual reset. Pass `dismissedOnly: true` to only purge already-dismissed rows and keep currently-visible ones; default removes EVERYTHING. Irreversible.

_Parameter:_
- `dismissedOnly: boolean` — When true, only purge rows the user already dismissed; keeps active (still-visible) alerts. Default false (purge all).

### `alerts_set_prefs`

_Datei:_ `services/desktop/src/main/agent/tools/alerts.ts`

Patch heartbeat / push preferences. Only fields you set are changed; everything else stays. Use when the user says things like 'heartbeat alle 30 Minuten', 'push aus', 'nur dringende Meldungen pushen', 'ruhezeiten von 20 bis 8 Uhr', 'keine Push am Wochenende'. For ruhezeiten pass `quietHours.startMinute` / `endMinute` as minutes-since-midnight in local time (e.g. 19:00 = 1140, 7:00 = 420).

_Parameter:_
- `cadenceMinutes: integer (enum: 0, 5, 15, 30, 60)` — Heartbeat cadence in minutes. 0 disables the timer (manual triggers still work).
- `pushEnabled: boolean` — Toggle native OS notifications.
- `pushSeverityThreshold: string (enum: info, warn, urgent)` — Minimum severity that fires a native push. Lower-severity alerts still land in the bell.
- `quietHours: object` — Window during which native push is silenced. Wrap-around (e.g. 19:00→07:00) is supported.

### `alerts_trigger_heartbeat`

_Datei:_ `services/desktop/src/main/agent/tools/alerts.ts`

Force a heartbeat tick NOW, regardless of cadence. Returns the per-candidate decision log (alerted / duplicate / not-worth / judge-error) plus counters. Use when the user says 'check jetzt', 'run heartbeat', 'prüfe nach neuen Meldungen'. Same effect as the 'Jetzt auslösen' button in Settings.

_Parameter:_ keine.

## Aktualisierung (Freshness) (6)

### `freshness_get_prefs`

_Datei:_ `services/desktop/src/main/agent/tools/freshness.ts`

Read the current freshness scheduler preferences (master toggle, per-stage cadences in days, throttle ceilings, pinned companies). Call before `freshness_set_prefs` if you're unsure of the current state.

_Parameter:_ keine.

### `freshness_pin_company`

_Datei:_ `services/desktop/src/main/agent/tools/freshness.ts`

Pin a company so its stale cells always sort to the top of the freshness queue (10× score boost). Use when the user says 'priorisiere ACME', 'ACME zuerst', 'pin Foo GmbH'. Idempotent: pinning an already-pinned company is a no-op.

_Parameter:_
- `companyId: string` (required) — Company id to pin.

### `freshness_run_now`

_Datei:_ `services/desktop/src/main/agent/tools/freshness.ts`

Force a freshness tick NOW, regardless of the 30-min cadence. The scheduler scores every (companyId, stage) cell and dispatches up to `topKPerTick` retries (default 5), respecting the per-stage and global hourly throttle. Use when the user says 'aktualisiere jetzt', 'starte Refresh', 'check freshness'. Returns the rows that actually got dispatched + the throttle-skipped ones.

_Parameter:_ keine.

### `freshness_scan`

_Datei:_ `services/desktop/src/main/agent/tools/freshness.ts`

Read-only: trigger a freshness scan now and return the top stale (companyId, stage) rows the scheduler would consider. Use when the user asks 'welche Firmen sind veraltet', 'was steht zur Aktualisierung an', 'wann lief contact für ACME zuletzt'. Does NOT dispatch retries; pair with `freshness_run_now` for the action.

_Parameter:_ keine.

### `freshness_set_prefs`

_Datei:_ `services/desktop/src/main/agent/tools/freshness.ts`

Patch freshness scheduler preferences. Only fields you set are changed. Use for things like 'auto-Aktualisierung aus' (`enabled: false`), 'profil alle 3 Tage' (`cadenceDays: { companyProfile: 3 }`), 'maximal 5 Retries pro Stunde' (`throttle: { globalPerHour: 5 }`). Cadence days are integers; 0 = stage opt-out (manual retries still work). To manage pinned companies use `freshness_pin_company` / `freshness_unpin_company` instead — those are atomic add/remove and don't require resending the whole list.

_Parameter:_
- `enabled: boolean` — Master toggle. False pauses the scheduler entirely.
- `cadenceDays: object` — Per-stage cadence in days. Each key is optional; only set the stages you want to change.
- `throttle: object`
- `topKPerTick: integer` — Max retries dispatched per scheduler tick. Soft cap on top of the hourly throttle.

### `freshness_unpin_company`

_Datei:_ `services/desktop/src/main/agent/tools/freshness.ts`

Remove a company from the freshness pin list. Use when the user says 'unpin ACME', 'ACME normal sortieren', 'ACME nicht mehr priorisieren'. Idempotent.

_Parameter:_
- `companyId: string` (required) — Company id to unpin.

## Watches (5)

### `watch_list`

_Datei:_ `services/desktop/src/main/agent/tools/watches.ts`

List the user's standing watches (newest first) with id, prompt, cadence, trigger scope, last-checked timestamp, and active state. Use when the user asks 'was beobachtest du gerade für mich' / 'welche Watches sind aktiv'. Always returns the count + cap so the agent can warn the user when they're near the limit.

_Parameter:_ keine.

### `watch_pause`

_Datei:_ `services/desktop/src/main/agent/tools/watches.ts`

Disable a watch (`enabled: false`) without deleting it. The executor skips paused watches; resume with `watch_resume`. Use when the user says 'pausiere den ACME-Watch'.

_Parameter:_
- `id: string` (required)

### `watch_register`

_Datei:_ `services/desktop/src/main/agent/tools/watches.ts`

Register a new standing watch. Translate the user's natural-language phrasing into a `trigger.rubric` (a German one-line criterion the LLM judge will evaluate against future candidates) plus optional `companyIds` / `topics` scoping. ALWAYS go through propose-and-confirm: the tool itself shows the draft via `ask_user_choice` and only persists on user confirm. Cap is 20 active watches; the tool refuses past that with a German message the user can read verbatim. After a successful register, the next heartbeat tick (or the next `alerts_trigger_heartbeat` call) will start evaluating the rubric.

When the user names a specific company ('schau auf ACME'), resolve the companyId via `company_search` first and pass it in `companyIds`. When the user names a clear data type ('nur Publikationen'), pass it in `topics`. When the user is generic ('immer wenn etwas Wichtiges passiert'), leave both empty — the rubric carries the meaning.

_Parameter:_ keine.

### `watch_remove`

_Datei:_ `services/desktop/src/main/agent/tools/watches.ts`

Delete a watch by id. Idempotent — removing an unknown id reports `wasFound: false` cleanly. Use when the user says 'lösche den ACME-Watch'. Get the id via `watch_list` first if the user named the watch by topic, not by id.

_Parameter:_
- `id: string` (required) — Watch id from watch_list[].id.

### `watch_resume`

_Datei:_ `services/desktop/src/main/agent/tools/watches.ts`

Re-enable a paused watch (`enabled: true`). Use when the user says 'aktiviere den ACME-Watch wieder' / 'resume X'. Refuses with the cap message if re-activating would push past the active limit.

_Parameter:_
- `id: string` (required)

## Profil (4)

### `profile_clear`

_Datei:_ `services/desktop/src/main/agent/tools/profile.ts`

Wipe the profile back to defaults. Use when the user explicitly says 'vergiss, was du über mich weißt', 'profil zurücksetzen', 'forget my profile'. Destructive; no propose-and-confirm gate (the user already explicitly asked).

_Parameter:_ keine.

### `profile_get`

_Datei:_ `services/desktop/src/main/agent/tools/profile.ts`

Read the user's stored profile (bio, role, industries, geographies, topics, tone, skip flag). Call before `profile_propose_update` if you're unsure what's already known. Empty profile returns the default shape with empty fields.

_Parameter:_ keine.

### `profile_propose_update`

_Datei:_ `services/desktop/src/main/agent/tools/profile.ts`

Propose-and-confirm path for AGENT-INFERRED profile updates. Use when you've observed stable signals across the conversation ('user mentioned they work in Vertrieb' + 'they focus on Bayern' + 'they care about Geschäftsführer-Wechsel'). Renders an ask_user_choice card showing the proposed patch verbatim; user confirms → applied. NEVER use this to write silently — the gate is the whole point. Call `ask_user_choice` separately yourself if you want the user to confirm a more nuanced wording. Skip if the user already explicitly told you the same thing in the SAME conversation (use `profile_set` directly).

_Parameter:_ keine.

### `profile_set`

_Datei:_ `services/desktop/src/main/agent/tools/profile.ts`

Direct write to the user profile. Only call when the user EXPLICITLY asked ('update my bio to …', 'I work at X now', 'set my tone to knapp') OR when the user is responding to the first-run nudge. For AGENT-INFERRED updates use `profile_propose_update` instead — the user must confirm what you observed before it persists. Pass only the fields that should change; everything else stays.

_Parameter:_ keine.

## Langzeit-Gedächtnis (3)

### `forget_memory`

_Datei:_ `services/desktop/src/main/agent/tools/memory.ts`

Delete a long-term memory entry by id. Get the id from `recall_memory` first — the user usually says "vergiss [thing]" or "lösche, dass …", and you should look up the matching entry, confirm with the user that you've found the right one (single-shot `ask_user_choice` with Ja/Nein when there's any ambiguity), and only then call this. Irreversible.

_Parameter:_
- `id: string` (required) — Entry id from `recall_memory[].entries[].id`.

### `recall_memory`

_Datei:_ `services/desktop/src/main/agent/tools/memory.ts`

Look up long-term memory the user has asked you to remember across conversations (preferences, facts about them, ongoing tasks). Call this proactively at the start of a turn when the user's question hints at prior context ("as I mentioned", "remember the …", or anything pronoun-heavy without an antecedent in this conversation). Returns matching entries newest-first; an empty `query` returns recent entries.

_Parameter:_
- `query: string` — Substring or keyword to filter entries by (matches content + tags, case-insensitive). Leave empty to list recent entries.
- `limit: integer` — Max entries to return. Default 10.

### `remember`

_Datei:_ `services/desktop/src/main/agent/tools/memory.ts`

Save a fact, preference, or note to long-term memory so you can recall it in future conversations. Use this when the user explicitly asks ("remember that …", "keep this in mind") OR when they share a stable preference you'd want to honour next time (preferred language, role, recurring company they care about). Do NOT save volatile per-conversation context — that's already in transcript memory.

_Parameter:_
- `content: string` (required) — The fact to remember, written as a self-contained sentence. Future-you will read this without conversation context, so don't say "the company we just discussed" — name it.
- `tags: array` — Optional short tags for grouping (e.g. "preference", "company:acme"). Lowercase, no spaces.

## Einstellungen (4)

### `settings_clear_api_key`

_Datei:_ `services/desktop/src/main/agent/tools/settings.ts`

Forget the stored API key for a hosted provider. If that provider was active it auto-falls-back to the local Ollama model.

_Parameter:_ keine.

### `settings_get_provider`

_Datei:_ `services/desktop/src/main/agent/tools/settings.ts`

Read the active LLM provider configuration plus per-provider key presence. Use this BEFORE proposing a switch so you can confirm what's currently set and which providers are usable.

_Parameter:_ keine.

### `settings_set_api_key`

_Datei:_ `services/desktop/src/main/agent/tools/settings.ts`

Store the user's API key for a hosted provider. Encrypted at rest via the OS keychain (safeStorage). Call this BEFORE switching to that provider. Never echo the key back in your reply.

_Parameter:_ keine.

### `settings_set_provider`

_Datei:_ `services/desktop/src/main/agent/tools/settings.ts`

Switch the active LLM provider. `kind` is one of 'ollama', 'openai', 'anthropic', 'google', 'mistral'. Hosted providers require their API key to be stored first via `settings_set_api_key`. Optionally override the model tag for the chosen provider.

_Parameter:_ keine.

## CRM (8)

### `connect_crm`

_Datei:_ `services/desktop/src/main/agent/tools/crm.ts`

Start the interactive OAuth flow to connect a CRM. Opens the system browser to the provider's login page and waits for the redirect. Microsoft Dynamics requires `orgUrl` (e.g. 'contoso.crm4.dynamics.com'). The user must complete sign-in in the browser; this tool resolves once tokens are persisted.

_Parameter:_ keine.

### `crm_enrich_now`

_Datei:_ `services/desktop/src/main/agent/tools/crm.ts`

Stößt eine sofortige Anreicherung der CRM-Daten für eine bereits verknüpfte Firma an (aktuell nur HubSpot). Verwende das Tool, wenn der Nutzer 'jetzt aus dem CRM neu laden' oder 'Daten aktualisieren' verlangt. Setzt voraus, dass HubSpot verbunden ist und eine bestehende Verknüpfung existiert. Liefert einen freundlichen Fehler, wenn HubSpot nicht verbunden ist.

_Parameter:_ keine.

### `crm_fetch_details_raw`

_Datei:_ `services/desktop/src/main/agent/tools/crm.ts`

Liefert den vollständigen, ungekürzten CRM-Anreicherungs-Payload für eine Firma (alle Felder, alle Kontakte, alle Deals, alle Notizen). Anders als `company_crm_summary` ist hier nichts gefiltert. Verwende das Tool, wenn der Nutzer ein konkretes Feld abruft, das in der Übersicht fehlt. Mit `refresh: true` wird der Cache ignoriert und ein frischer Fetch ausgelöst (Quota-relevant).

_Parameter:_
- `companyId: string` (required) — AVA Master-Data companyId.
- `refresh: boolean` — true = Cache ignorieren und neu beim CRM anfragen. Default false.

### `crm_link_manual`

_Datei:_ `services/desktop/src/main/agent/tools/crm.ts`

Verknüpft eine AVA-Firma manuell mit einem CRM-Datensatz, z. B. wenn der Nutzer sagt 'verknüpfe ACME mit HubSpot 12345'. Anzeigename ist optional, hilft aber bei späterer Identifikation. Setzt voraus, dass die Verknüpfung im CRM existiert (prüfe ggf. vorher mit `crm_search_hubspot_companies`).

_Parameter:_ keine.

### `crm_list_links_for_company`

_Datei:_ `services/desktop/src/main/agent/tools/crm.ts`

Listet alle CRM-Verknüpfungen einer AVA-Firma auf (CRM-Typ, externe ID, Anzeigename). Nutze das Tool, wenn der Nutzer wissen will, mit welchen CRM-Einträgen eine Firma verbunden ist. Liefert eine leere Liste, wenn keine Verknüpfung existiert.

_Parameter:_
- `companyId: string` (required) — AVA Master-Data companyId.

### `crm_search_hubspot_companies`

_Datei:_ `services/desktop/src/main/agent/tools/crm.ts`

Sucht in HubSpot nach Firmen anhand eines Stichworts (z. B. Name oder Domain). Liefert bis zu `limit` Kandidaten mit id, name, domain, city zurück, nützlich, um vor `crm_link_manual` den richtigen HubSpot-Datensatz zu finden. Setzt voraus, dass HubSpot verbunden ist.

_Parameter:_
- `query: string` (required) — Suchbegriff (Name oder Domain).
- `limit: integer` (default: 25) — Maximale Treffer (1 bis 100).

### `crm_status`

_Datei:_ `services/desktop/src/main/agent/tools/crm.ts`

Read CRM connection status. Without `provider`, returns the status of all supported CRMs (Salesforce, HubSpot, Microsoft Dynamics 365). Includes connected account label and last refresh timestamp; never returns tokens.

_Parameter:_ keine.

### `disconnect_crm`

_Datei:_ `services/desktop/src/main/agent/tools/crm.ts`

Forget OAuth tokens for a CRM provider. The user can re-connect later via `connect_crm` or the Settings panel.

_Parameter:_ keine.

## LinkedIn (6)

### `linkedin_connect`

_Datei:_ `services/desktop/src/main/agent/tools/linkedin.ts`

Öffnet das LinkedIn-Login-Fenster, damit der Nutzer die Sitzungs-Cookies erfassen kann. Verwende das Tool, wenn der Nutzer LinkedIn neu verbinden, die Verbindung wiederherstellen oder den Beobachter erstmals einrichten möchte. Das Tool wartet, bis der Nutzer den Login abgeschlossen oder das Fenster geschlossen hat.

_Parameter:_ keine.

### `linkedin_disconnect`

_Datei:_ `services/desktop/src/main/agent/tools/linkedin.ts`

Trennt die LinkedIn-Verbindung, indem die gespeicherten Cookies vergessen werden. Der Beobachter bleibt konfiguriert; der Nutzer kann sich später per `linkedin_connect` neu anmelden.

_Parameter:_ keine.

### `linkedin_killswitch`

_Datei:_ `services/desktop/src/main/agent/tools/linkedin.ts`

Notfall-Stopp des kompletten LinkedIn-Beobachters: vergisst alle Cookies, Posts, Signale und Einstellungen unter userData/linkedin/. Verwende das Tool nur, wenn der Nutzer ausdrücklich 'alles vergessen' oder 'Kill-Switch' verlangt. Nach dem Aufruf ist eine komplette Neueinrichtung nötig.

_Parameter:_ keine.

### `linkedin_scan_cancel`

_Datei:_ `services/desktop/src/main/agent/tools/linkedin.ts`

Bricht einen laufenden LinkedIn-Scan ab. Sinnvoll, wenn der Scan hängt oder der Nutzer die Aktion stoppen möchte.

_Parameter:_ keine.

### `linkedin_signals_cancel`

_Datei:_ `services/desktop/src/main/agent/tools/linkedin.ts`

Bricht die laufende LinkedIn-Signal-Extraktion ab. Verwende das Tool, wenn der Nutzer die KI-Auswertung der gescrapten Posts stoppen möchte.

_Parameter:_ keine.

### `linkedin_status`

_Datei:_ `services/desktop/src/main/agent/tools/linkedin.ts`

Liest den Verbindungsstatus des LinkedIn-Beobachters: ob ein Login vorhanden ist, wann die Sitzung erfasst wurde, die member-URN und ob der Kill-Switch aktiv ist. Nutze das Tool, wenn der Nutzer fragt, ob LinkedIn verbunden ist oder warum der Monitor nichts tut.

_Parameter:_ keine.

## UI-Helfer (4)

### `ask_user_choice`

_Datei:_ `services/desktop/src/main/agent/tools/ui.ts`

Ask the user to pick one option. Use when a search returns multiple plausible matches and you cannot reasonably guess. Returns the picked option's `value` string.

_Parameter:_
- `prompt: string` (required) — Short question shown above the buttons.
- `options: array` (required) — Choices the user can pick from.

### `ask_user_text`

_Datei:_ `services/desktop/src/main/agent/tools/ui.ts`

Ask the user for a free-form line of text (e.g. a transaction name, a custom keyword). Renders as a small input field in the chat with optional default value and 'Überspringen' button. Returns the typed string — empty string means the user skipped an optional prompt. Prefer `ask_user_choice` whenever the answer set is finite.

_Parameter:_ keine.

### `navigate`

_Datei:_ `services/desktop/src/main/agent/tools/ui.ts`

Switch the renderer to another route. Paths are SPA-relative, e.g. `/companies/<id>`, `/transactions`, `/chat`. Use AFTER fetching data so the user lands on a populated view.

_Parameter:_
- `path: string` (required) — SPA path beginning with `/`.

### `notify`

_Datei:_ `services/desktop/src/main/agent/tools/ui.ts`

Show a native OS notification. Use sparingly — only for events the user genuinely wants pushed (e.g. 'transaction X finished'). Do not use for chat replies.

_Parameter:_
- `title: string` (required) — Bold first line.
- `body: string` (required) — One short sentence.
