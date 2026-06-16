# AVA Agent-Tools

Auto-generiert von `services/desktop/scripts/generate-tools-md.mjs`.
NICHT direkt bearbeiten — die Quelle der Wahrheit ist `services/desktop/src/main/agent/tools/*.ts`.
Lauf via `pnpm -F @ava/desktop tools:doc` (oder automatisch via `build:typecheck`).

Stand: 2026-06-16
Anzahl Tools: 162

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

## Importe (6)

### `import_companies`

_Datei:_ `services/desktop/src/main/agent/tools/imports.ts`

Bulk-import a pasted LIST of companies as ONE transaction (full master-data pipeline: profile, website, publications, contacts, evaluations). Use this whenever the user pastes / names MULTIPLE companies in chat and there is NO file attachment and NO connected-CRM source (e.g. a list copied from LinkedIn). Do NOT loop `import_company` per row — that creates one transaction per company and scatters the Transactions view. WORKFLOW: call FIRST with `dryRun: true` — you get back a matching preview AND a downloadable Excel report (path in `reportPath`). Show the user the matched / not-uniquely-matched companies and the report link, let them confirm or correct, THEN call again with `dryRun: false` to commit. Each row needs name + city (city disambiguates same-named companies); if the user didn't give cities, use the best-known HQ city — the dry-run report will flag wrong guesses as not-uniquely-matched. Returns a transactionId on commit; progress via `import_status`.

_Parameter:_ keine.

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
- `stage: string (enum: structuredContent, companyPublication, website, companyProfile, companyContact, companyEvaluation, deepResearch, jobPostings)` (required) — Which stage to re-run. `companyEvaluation` fans out across all 5 evaluation producers in parallel.
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

## Einstellungen (6)

### `settings_clear_anthropic_subscription_token`

_Datei:_ `services/desktop/src/main/agent/tools/settings.ts`

Entfernt den gespeicherten Anthropic-Subscription-OAuth-Token. Falls Subscription der aktive Anthropic-Auth-Modus war, wird auf 'api-key' zurückgeschaltet (sofern ein Api-Schlüssel hinterlegt ist) oder der aktive Provider auf Ollama gewechselt.

_Parameter:_ keine.

### `settings_clear_api_key`

_Datei:_ `services/desktop/src/main/agent/tools/settings.ts`

Forget the stored API key for a hosted provider. If that provider was active it auto-falls-back to the local Ollama model.

_Parameter:_ keine.

### `settings_get_provider`

_Datei:_ `services/desktop/src/main/agent/tools/settings.ts`

Read the active LLM provider configuration plus per-provider key presence. Use this BEFORE proposing a switch so you can confirm what's currently set and which providers are usable.

_Parameter:_ keine.

### `settings_set_anthropic_subscription_token`

_Datei:_ `services/desktop/src/main/agent/tools/settings.ts`

Speichert einen Claude.ai-Subscription-OAuth-Token (vom `claude setup-token`-CLI erzeugt). Nutzt das Pro/Max-Abo des Nutzers statt Api-Credits. Der Token wird verschlüsselt im OS-Schlüsselbund abgelegt; gleichzeitig wird der Anthropic-Auth-Modus auf 'subscription' geschaltet. Niemals den Token in der Antwort wiedergeben.

_Parameter:_ keine.

### `settings_set_api_key`

_Datei:_ `services/desktop/src/main/agent/tools/settings.ts`

Store the user's API key for a hosted provider. Encrypted at rest via the OS keychain (safeStorage). Call this BEFORE switching to that provider. Never echo the key back in your reply. NOTE: Anthropic is intentionally NOT supported here — the user should connect via the Pro/Max subscription (Settings → Modelle → Anthropic).

_Parameter:_ keine.

### `settings_set_provider`

_Datei:_ `services/desktop/src/main/agent/tools/settings.ts`

Switch the active LLM provider. `kind` is one of 'ollama', 'openai', 'anthropic', 'google', 'mistral'. Hosted providers require their API key to be stored first via `settings_set_api_key`. Optionally override the model tag for the chosen provider.

_Parameter:_ keine.

## CRM (30)

### `connect_crm`

_Datei:_ `services/desktop/src/main/agent/tools/crm.ts`

Startet den interaktiven OAuth-Flow für ein CRM. Öffnet den System-Browser zur Login-Seite des Anbieters und wartet auf die Weiterleitung. AKTUELL VERFÜGBAR: nur HubSpot. Salesforce und Microsoft Dynamics 365 sind als Optionen sichtbar, aber für Nutzer noch gesperrt ("Demnächst verfügbar"); der Tool-Call lehnt sie mit einer klaren Meldung ab. Nach erfolgreicher HubSpot-Verbindung kann der Nutzer mit `import_companies_from_crm` direkt importieren oder einzelne AVA-Firmen via `crm_link_manual` an CRM-Datensätze knüpfen.

_Parameter:_ keine.

### `crm_associate_hubspot_objects`

_Datei:_ `services/desktop/src/main/agent/tools/crm.ts`

Verknüpft zwei HubSpot-Records (Contact↔Company, Deal↔Company, Contact↔Deal) mit dem Default-Association-Type. PROPOSE-AND-CONFIRM: zeigt den Nutzer via ask_user_choice was verknüpft werden soll. Idempotent: bestehende Verknüpfung wird nicht doppelt erstellt. Custom-Association-Types werden NICHT unterstützt — V1 setzt immer den default.

_Parameter:_ keine.

### `crm_complete_hubspot_task`

_Datei:_ `services/desktop/src/main/agent/tools/crm.ts`

Markiert eine HubSpot-Task als erledigt: setzt hs_task_status=COMPLETED und hs_task_completion_date=jetzt (oder den vom Nutzer genannten Zeitpunkt). PROPOSE-AND-CONFIRM via ask_user_choice — wie alle Schreib-Operationen.

_Parameter:_ keine.

### `crm_create_hubspot_company`

_Datei:_ `services/desktop/src/main/agent/tools/crm.ts`

Legt eine NEUE Company in HubSpot an. Propose-and-Confirm via ask_user_choice. PFLICHT VORHER: crm_search_hubspot_companies aufrufen, um Dubletten zu erkennen — wenn schon eine Company mit dem Namen oder der Domain existiert, dem Nutzer das TRANSPARENT zeigen und nachfragen (Update statt Create? oder ist das ein anderer Account?). Mindestens `name` ist Pflicht; alle weiteren Properties (domain, industry, lifecyclestage, …) sind optional und werden 1:1 ans HubSpot-API gereicht. Bei enum-Feldern den value, nicht das label.

Wenn der Nutzer ein Pendant zu einer bereits in AVA bekannten Firma anlegt (Standard-Use-Case), IMMER auch `linkToAvaCompanyId` mitgeben — dann wird die HubSpot-Verknüpfung in einem Schritt mit angelegt, der Nutzer muss nichts manuell in der Firmenseite nachziehen. AVA-companyId vorher via `company_search` auflösen.

v0.1.311 — AUTO-ANREICHERUNG: Wenn `linkToAvaCompanyId` gegeben ist, fetcht das Tool SELBST die AVA-Companydaten (legalName, Adresse, Website, Domain, Headcount, Branche, Beschreibung, Umsatz aus Pubs) und befüllt die HubSpot-Properties automatisch. Du musst die Properties also NICHT selbst zusammenklauben — gib einfach name + linkToAvaCompanyId mit, der Rest passiert automatisch. Du musst eigene Properties NUR mitgeben, wenn du etwas Konkretes ergänzen oder überschreiben willst (deine Werte gewinnen gegen die AVA-Daten).

WENN AVA NOCH KEINE DATEN HAT (Pipeline noch nicht gelaufen), bricht das Tool mit klarer Fehlermeldung ab. Reaktion: dem User sagen, dass die Firma zuerst in AVA recherchiert werden muss (Tab 'Firmen' → Firma → 'neu recherchieren'). Erst danach in HubSpot anlegen. Workaround für Notfälle: OHNE linkToAvaCompanyId aufrufen — dann landet nur Name (+ ggf. explizite Domain/Properties) in HubSpot, der User muss den Rest manuell pflegen.

_Parameter:_ keine.

### `crm_create_hubspot_contact`

_Datei:_ `services/desktop/src/main/agent/tools/crm.ts`

Legt einen NEUEN Contact in HubSpot an. PROPOSE-AND-CONFIRM via ask_user_choice. PFLICHT vorher: crm_search_hubspot_contacts mit der email — wenn schon ein Contact mit dieser email existiert, dem Nutzer das transparent zeigen und Update statt Create vorschlagen. Pflichtfeld ist `email` (HubSpots Dedup-Key). Empfohlen: firstname, lastname. Optional: linkToHubspotCompanyId für Inline-Verknüpfung zur Company.

_Parameter:_
- `email: string` (required) — E-Mail (Pflicht, HubSpots Dedup-Key).
- `firstname: string`
- `lastname: string`
- `jobtitle: string`
- `phone: string`
- `properties: object` — Zusätzliche HubSpot-Properties (Name → String).
- `linkToHubspotCompanyId: string` — Optionale HubSpot-companyId; Contact wird inline mit der Company verknüpft.
- `rationale: string`

### `crm_create_hubspot_deal`

_Datei:_ `services/desktop/src/main/agent/tools/crm.ts`

Legt einen NEUEN Deal in HubSpot an. PROPOSE-AND-CONFIRM via ask_user_choice. PFLICHT vorher: crm_introspect_hubspot_deal auf einem existierenden Deal aufrufen, um pipeline + dealstage-Optionen zu kennen (dealstage ist an pipeline gekoppelt — falsche Kombination wird silently rejected). Pflichtfelder: dealname, pipeline, dealstage. associations (Company/Contact) ist OPTIONAL und EMPFOHLEN: gib mind. 1 Verknüpfung an, dann wird sie direkt mit angelegt; lässt du sie weg, entsteht zunächst ein Deal ohne Verknüpfung, den du danach mit crm_associate_hubspot_objects verknüpfen kannst. Optional: amount, closedate (ISO), dealtype, hubspot_owner_id, weitere Properties.

_Parameter:_ keine.

### `crm_create_hubspot_note`

_Datei:_ `services/desktop/src/main/agent/tools/crm.ts`

Legt eine neue Notiz in HubSpot an und verknüpft sie SOFORT mit mindestens einem Company/Contact/Deal — sonst ist die Notiz in der UI quasi unauffindbar. PROPOSE-AND-CONFIRM via ask_user_choice. Body kann Plain-Text oder einfaches HTML enthalten. Zeitstempel wird auf 'jetzt' gesetzt, wenn nicht überschrieben.

_Parameter:_ keine.

### `crm_create_hubspot_task`

_Datei:_ `services/desktop/src/main/agent/tools/crm.ts`

Legt eine neue Aufgabe in HubSpot an und verknüpft sie SOFORT mit Company/Contact/Deal. PROPOSE-AND-CONFIRM. Optional sind Fälligkeit, Priorität, Owner, Typ (EMAIL/CALL/TODO). Status startet immer auf NOT_STARTED.

_Parameter:_ keine.

### `crm_delete_hubspot_${SINGULAR[objectType]}`

_Datei:_ `services/desktop/src/main/agent/tools/crm.ts`

Löscht (= archiviert) einen HubSpot-${label}. PROPOSE-AND-CONFIRM via ask_user_choice mit Record-Vorschau. HubSpot stellt den Record 90 Tage lang wieder her — danach endgültig weg. Bei Companies/Contacts/Deals werden Verknüpfungen automatisch gelöst, die verbundenen Records selbst bleiben erhalten.

_Parameter:_
- `objectId: string` (required)
- `rationale: string` — Begründung (1 Satz).

### `crm_disassociate_hubspot_objects`

_Datei:_ `services/desktop/src/main/agent/tools/crm.ts`

Entfernt eine bestehende Verknüpfung zwischen zwei HubSpot-Records. PROPOSE-AND-CONFIRM via ask_user_choice. DESTRUCTIVE: die Records selbst bleiben erhalten, nur die Beziehung wird gelöscht. Wenn die Verknüpfung gar nicht existiert hat, returnt HubSpot 204 OK — Tool meldet trotzdem applied:true.

_Parameter:_ keine.

### `crm_enrich_hubspot_company_from_ava`

_Datei:_ `services/desktop/src/main/agent/tools/crm.ts`

Aktualisiert eine BESTEHENDE HubSpot-Company mit Daten aus AVA. Holt AVA-Daten (legalName, Adresse, Website, Domain, Headcount, Branche, Beschreibung, Umsatz aus letzter Publikation), baut den Diff gegen die aktuellen HubSpot-Werte und zeigt im Confirm-Dialog WAS geändert wird. Nur Felder mit echtem Wert in AVA + Unterschied gegen HubSpot werden vorgeschlagen. Use-Case: 'Reicher die HubSpot-Firma Strategic IT mit den neuesten AVA-Daten an.'

Voraussetzung: AVA-Pipeline ist für die Firma gelaufen (sonst sagt das Tool das klar). HubSpot-companyId vorher z. B. via crm_search_hubspot_companies oder crm_list_links_for_company auflösen.

_Parameter:_
- `hubspotCompanyId: string` (required) — HubSpot-companyId der zu aktualisierenden Firma.
- `avaCompanyId: string` (required) — AVA-companyId der Quell-Firma (vorher via company_search auflösen).
- `rationale: string` — Kurze Begründung (1 Satz) für den Confirm-Dialog.

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

### `crm_introspect_hubspot_${SINGULAR[objectType]}`

_Datei:_ `services/desktop/src/main/agent/tools/crm.ts`

Liest das Property-Schema einer HubSpot-${objectLabel} UND die aktuellen Werte. Nutze das vor crm_update_hubspot_${SINGULAR[objectType]}, sobald du die HubSpot-${objectLabel}-ID hast (${idParamHint}). Returned: für jedes editierbare Feld den Property-Namen, Label, Type, enum-Optionen (mit label + value), Beschreibung und aktueller Wert. Read-only/system-Felder sind rausgefiltert.

_Parameter:_ keine.

### `crm_introspect_hubspot_company`

_Datei:_ `services/desktop/src/main/agent/tools/crm.ts`

Liest das Property-Schema einer HubSpot-Company UND die aktuellen Werte. Nutze das als STEP 2 vor `crm_update_hubspot_company`, sobald du via `crm_list_links_for_company` oder `crm_search_hubspot_companies` die HubSpot-companyId hast. Returned: für jedes editierbare Feld den Property-Namen, Label, Type (string/number/date/enumeration/bool), enum-Optionen (wenn enumeration), die Beschreibung und den aktuell gespeicherten Wert. Read-only-Felder (hs_object_id, calculated etc.) sind rausgefiltert. Wähle aus der Liste das Feld(er), das der Nutzer ändern will, mappe ggf. Label→value bei Enum-Feldern und übergib das Map an `crm_update_hubspot_company`.

_Parameter:_
- `companyId: string` (required) — HubSpot-companyId (NICHT die AVA-Master-Data-companyId). Aus `crm_list_links_for_company` oder `crm_search_hubspot_companies`.

### `crm_link_manual`

_Datei:_ `services/desktop/src/main/agent/tools/crm.ts`

Verknüpft eine AVA-Firma manuell mit einem CRM-Datensatz, z. B. wenn der Nutzer sagt 'verknüpfe ACME mit HubSpot 12345'. Anzeigename ist optional, hilft aber bei späterer Identifikation. Setzt voraus, dass die Verknüpfung im CRM existiert (prüfe ggf. vorher mit `crm_search_hubspot_companies`).

_Parameter:_ keine.

### `crm_list_hubspot_associations`

_Datei:_ `services/desktop/src/main/agent/tools/crm.ts`

Listet die Verknüpfungen eines HubSpot-Records zu einem anderen Object-Type. Beispiele: alle Contacts einer Company, alle Deals einer Company, alle Deals eines Contacts. Returned: Liste mit toObjectId + association-type-Labels. Read-only — keine Schreibänderung.

_Parameter:_ keine.

### `crm_list_hubspot_notes_for_object`

_Datei:_ `services/desktop/src/main/agent/tools/crm.ts`

Listet die Notizen, die mit einem bestimmten HubSpot-Record (Company/Contact/Deal) verknüpft sind. Neueste zuerst. Returns id, body (Plain-Text), createdAt, ownerId.

_Parameter:_ keine.

### `crm_list_hubspot_owners`

_Datei:_ `services/desktop/src/main/agent/tools/crm.ts`

Listet alle aktiven HubSpot-Owner des Portals (id + email + firstName + lastName). Nutze das, BEVOR du ein hubspot_owner_id-Feld setzen willst — der Nutzer sagt meistens den Namen, HubSpot erwartet die numerische Owner-ID. Mappe Name/E-Mail aus der Liste auf die id.

_Parameter:_ keine.

### `crm_list_hubspot_tasks`

_Datei:_ `services/desktop/src/main/agent/tools/crm.ts`

Listet HubSpot-Tasks mit Filtern: ownerId (z. B. der angemeldete User), statuses (Liste aus NOT_STARTED/IN_PROGRESS/COMPLETED/WAITING/DEFERRED), dueBy (ISO-Timestamp). Sortiert aufsteigend nach Fälligkeit. Returns id, subject, status, priority, type, ownerId, dueAt, completedAt. Nutze ownerId+statuses=[NOT_STARTED,IN_PROGRESS] für 'meine offenen Aufgaben'.

_Parameter:_ keine.

### `crm_list_links_for_company`

_Datei:_ `services/desktop/src/main/agent/tools/crm.ts`

Listet alle CRM-Verknüpfungen einer AVA-Firma auf (CRM-Typ, externe ID, Anzeigename). Nutze das Tool, wenn der Nutzer wissen will, mit welchen CRM-Einträgen eine Firma verbunden ist. Liefert eine leere Liste, wenn keine Verknüpfung existiert.

_Parameter:_
- `companyId: string` (required) — AVA Master-Data companyId.

### `crm_log_hubspot_activity`

_Datei:_ `services/desktop/src/main/agent/tools/crm.ts`

Protokolliert eine Aktivität in HubSpot und verknüpft sie SOFORT mit Company/Contact/Deal. WICHTIG: Wähle den `activity`-Typ AUS DEM KONTEXT — NICHT pauschal eine Notiz anlegen: protokollierte E-Mail → `email`, protokollierter Anruf → `call`, Meeting/Termin → `meeting`, sonstige Aktennotiz → `note`. So landen Aktivitäten in HubSpot in der richtigen Spur (E-Mail-/Anruf-/Meeting-Timeline) statt als generische Notiz. PROPOSE-AND-CONFIRM via ask_user_choice. Für reine To-Dos/Wiedervorlagen nutze stattdessen crm_create_hubspot_task.

_Parameter:_ keine.

### `crm_search_hubspot_companies`

_Datei:_ `services/desktop/src/main/agent/tools/crm.ts`

Sucht in HubSpot nach Firmen anhand eines Stichworts (z. B. Name oder Domain). Liefert bis zu `limit` Kandidaten mit id, name, domain, city zurück, nützlich, um vor `crm_link_manual` den richtigen HubSpot-Datensatz zu finden. Setzt voraus, dass HubSpot verbunden ist.

_Parameter:_
- `query: string` (required) — Suchbegriff (Name oder Domain).
- `limit: integer` (default: 25) — Maximale Treffer (1 bis 100).

### `crm_search_hubspot_contacts`

_Datei:_ `services/desktop/src/main/agent/tools/crm.ts`

Sucht HubSpot-Contacts nach Name oder E-Mail-Adresse. Returns bis zu 25 Treffer mit id, firstName, lastName, email, jobTitle, company. Nutze das, um die contactId für crm_update_hubspot_contact aufzulösen.

_Parameter:_
- `query: string` (required) — Name, Vorname, oder E-Mail.
- `limit: integer` — Max Treffer (1-100). Default 25.

### `crm_search_hubspot_deals`

_Datei:_ `services/desktop/src/main/agent/tools/crm.ts`

Sucht HubSpot-Deals nach Name (dealname). Returns bis zu 25 Treffer mit id, name, amount, stage, pipeline, closeDate. Nutze das, um die dealId für crm_update_hubspot_deal aufzulösen.

_Parameter:_
- `query: string` (required) — Deal-Name (teilweise).
- `limit: integer` — Max Treffer (1-100). Default 25.

### `crm_status`

_Datei:_ `services/desktop/src/main/agent/tools/crm.ts`

Read CRM connection status. Without `provider`, returns the status of all supported CRMs (Salesforce, HubSpot, Microsoft Dynamics 365). Includes connected account label and last refresh timestamp; never returns tokens.

_Parameter:_ keine.

### `crm_sync_hubspot_company_from_ava`

_Datei:_ `services/desktop/src/main/agent/tools/crm.ts`

VOLL-SYNC einer AVA-Firma nach HubSpot in EINEM Schritt — der bevorzugte Weg, sobald der Nutzer eine in AVA bekannte Firma in HubSpot anlegen, aktualisieren oder anreichern will. Holt automatisch ALLE AVA-Daten (Stammdaten, Structured-Content, Profil, Website/SERP, Publikationen, Keywords, Kontakte) und befüllt die HubSpot-Felder nach festem Mapping: name = AVA-Name; address = Straße+Hausnummer; zip = PLZ; city = Stadt; country = Land; phone = Telefon; website/domain = Website; description = FIRMENPROFIL (company-profile-Producer); about_us („Über uns“) = UNTERNEHMENSGEGENSTAND (Handelsregister); numberofemployees = Mitarbeiterzahl aus dem JÜNGSTEN Jahresabschluss (company-publication-Producer — NICHT irgendeine Zahl); annualrevenue = Gesamtumsatz aus dem jüngsten Jahresabschluss; founded_year = Gründungsjahr; industry = Branche (gegen HubSpots Branchen-Enum gematcht); linkedin_company_page = LinkedIn-Unternehmensseite (falls vorhanden). Legt zusätzlich Geschäftsführer + Ansprechpartner als verknüpfte Contacts an (dedupliziert). Alles hinter EINER Sammel-Bestätigung — KEIN Feld-für-Feld-Nachfragen. Wenn keine `hubspotCompanyId` gegeben ist, sucht das Tool selbst nach Dubletten und fragt ggf. welche Firma gemeint ist bzw. legt neu an. Vorher die AVA-companyId via `company_search` auflösen. Wenn die Firma in AVA noch nicht recherchiert wurde, bricht das Tool mit klarem Hinweis ab.

_Parameter:_
- `avaCompanyId: string` (required) — AVA-Master-Data-companyId (via company_search auflösen).
- `hubspotCompanyId: string` — Optional: bekannte HubSpot-companyId. Wenn weggelassen, sucht das Tool nach Dubletten (Name/Domain) und legt sonst neu an.
- `includeContacts: boolean` — Geschäftsführer + Ansprechpartner als Contacts anlegen + verknüpfen. Default true.
- `rationale: string` — Optionale 1-Satz-Begründung für den Confirm-Dialog.

### `crm_update_hubspot_${SINGULAR[objectType]}`

_Datei:_ `services/desktop/src/main/agent/tools/crm.ts`

Aktualisiert eine oder mehrere Properties einer HubSpot-${objectLabel}. PFLICHT: vorher crm_introspect_hubspot_${SINGULAR[objectType]} aufrufen. PROPOSE-AND-CONFIRM: Tool zeigt Diff via ask_user_choice. Fresh-GET-Verify nach PATCH (HubSpot kann HTTP 200 liefern ohne zu speichern, z. B. bei Workflow-Validation). Property-Namen = HubSpot-interne Namen; bei enums den value statt label.

_Parameter:_ keine.

### `crm_update_hubspot_company`

_Datei:_ `services/desktop/src/main/agent/tools/crm.ts`

Aktualisiert eine oder mehrere Properties einer HubSpot-Company. PFLICHT: vorher `crm_introspect_hubspot_company` aufrufen, um Property-Namen + Typen + Enum-Optionen zu kennen. PROPOSE-AND-CONFIRM: das Tool zeigt dem Nutzer den geplanten Diff (Vorher → Nachher) via ask_user_choice; nur bei Confirm geht der PATCH ans HubSpot-API.

Nach dem PATCH macht das Tool einen Fresh-GET zur Verifikation: HubSpot kann (wie Notion) HTTP 200 zurückgeben, ohne den Wert wirklich zu speichern (z. B. wenn das Pipeline-Stage zur Lifecycle-Stage nicht passt oder ein Validation-Workflow zugreift). In dem Fall wird das Tool mit `ok: false` und der Liste betroffener Properties returned — verwerfen NICHT.

Property-Namen sind die HubSpot-internen Namen (`industry`, `lifecyclestage`, NICHT 'Industry'/'Lifecycle Stage'). Bei enum-Feldern den `value` aus den Schema-Optionen verwenden, nicht das `label`. Empty-String löscht das Feld.

_Parameter:_ keine.

### `disconnect_crm`

_Datei:_ `services/desktop/src/main/agent/tools/crm.ts`

Verwirft die OAuth-Tokens für einen CRM-Anbieter. Bestehende CompanyCrmLink-Einträge bleiben erhalten (nur das Token wird vergessen); der Nutzer kann sich später via `connect_crm` oder im Settings-Panel wieder anmelden.

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

Ask the user to pick one option. ONLY use when (a) a search/list tool already returned multiple plausible matches, AND (b) you genuinely cannot pick automatically (e.g. two companies with the same name in different cities, two databases with similar names). DO NOT use this to ask the user for information they already provided in the current message, and DO NOT use it as a shortcut around exploring with read-only tools first — if the answer is in `notion_introspect_database`, `notion_list_databases`, `company_search`, etc., call those tools INSTEAD of asking. When disambiguating between matches (e.g. several companies with the same name), DO NOT trim the list to 2-3 — present ALL plausible candidates the search returned, up to the 12-option cap (aim for ~10 when a company-name search returns many hits), so the right one is actually on screen. Put the location/Stadt in each option's `description` so look-alikes are distinguishable. You do NOT need to add a 'Sonstige'/free-text option yourself — the UI always appends a 'Sonstiges …' free-text field automatically. Returns the picked option's `value` string.

_Parameter:_
- `prompt: string` (required) — Short question shown above the buttons.
- `options: array` (required) — Choices the user can pick from. For disambiguation, include every plausible candidate (up to 12) rather than a trimmed shortlist.

### `ask_user_text`

_Datei:_ `services/desktop/src/main/agent/tools/ui.ts`

Ask the user for a free-form line of text. STRICT use-cases ONLY: (a) a transaction label / custom keyword / display name the user hasn't given yet, (b) a piece of context that NO tool can produce and that wasn't in the user's message. DO NOT use this to (1) re-ask for information already present in the user's last message, (2) confirm a Notion database / field name / status option / row id — those are all discoverable via `notion_list_databases` + `notion_introspect_database` + `notion_query_database`, (3) elicit a 'safer-sounding' synonym for a value the user already named (just attempt the write — the verify-after on write tools will flag mismatches with a clear error and you can correct from there), (4) ask the user to disambiguate company names — that's `company_search` + `ask_user_choice`. Renders as a small input field with optional default and 'Überspringen' button. Returns the typed string — empty means skipped. Prefer `ask_user_choice` whenever the answer set is finite.

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

## Chat-Verlauf (3)

### `chat_history_delete`

_Datei:_ `services/desktop/src/main/agent/tools/chat-history.ts`

Löscht eine frühere Chat-Sitzung dauerhaft anhand ihrer ID. Nutze das Tool nur, wenn der Nutzer es ausdrücklich verlangt („lösch den Chat von gestern“). Die Aktion ist nicht umkehrbar. Bestätige vorher kurz, welche Sitzung du löschst.

_Parameter:_
- `conversationId: string` (required) — Die ID der zu löschenden Konversation aus `chat_history_list`.

### `chat_history_list`

_Datei:_ `services/desktop/src/main/agent/tools/chat-history.ts`

Listet vergangene Chat-Sitzungen (Konversationen) sortiert nach Aktualität, neueste zuerst. Pro Eintrag: konversationsId, Label (erste Nutzer-Zeile, gekürzt), Zeitpunkt der letzten Änderung und Dateigröße. Nutze das Tool, wenn der Nutzer einen früheren Chat öffnen oder den Verlauf einsehen will. Anschließend `chat_history_load` mit der gewünschten ID aufrufen.

_Parameter:_
- `limit: integer` — Maximale Anzahl Einträge. Default 20.

### `chat_history_load`

_Datei:_ `services/desktop/src/main/agent/tools/chat-history.ts`

Lädt das Transkript einer früheren Chat-Sitzung anhand ihrer ID. Liefert die Nachrichtenliste mit Rolle (user / assistant / tool / system) und Inhalt. Nutze das Tool, nachdem `chat_history_list` die passende konversationsId geliefert hat. Unbekannte oder nicht lesbare IDs ergeben eine leere Nachrichtenliste.

_Parameter:_ keine.

## mail (8)

### `mail_allowlist_add`

_Datei:_ `services/desktop/src/main/agent/tools/mail.ts`

Fügt einen Absender (oder Domain-Wildcard *@kunde.de) der Mail-Allowlist hinzu. AVA darf danach autonom an diesen Absender antworten und auf seine Mails als 'trusted' reagieren. SICHERHEIT: IMMER propose-and-confirm via ask_user_choice — der Nutzer muss explizit zustimmen, weil diese Aktion die Angriffsfläche vergrößert. Niemals autonom ausführen, auch nicht 'auf Bitte des Nutzers'.

_Parameter:_ keine.

### `mail_archive`

_Datei:_ `services/desktop/src/main/agent/tools/mail.ts`

Archiviert eine Mail. Verschiebt die Mail physisch in den Archive-Folder des IMAP-Servers (RFC-6154 \Archive oder Heuristik: Archive/Archiv/All Mail) UND setzt das interne archived_at-Flag. Wenn der Server keinen Archive-Folder hat, bleibt es bei der Flag-only-Archivierung (Mail verschwindet trotzdem aus der Triage-Inbox).

_Parameter:_
- `messageId: string` (required)

### `mail_forward`

_Datei:_ `services/desktop/src/main/agent/tools/mail.ts`

Leitet eine Mail an einen anderen Empfänger weiter. Original-Mail wird als Quote im Body angehängt (englisch: 'Forwarded message'-Block). SICHERHEITSGATE: Wenn ALLE Empfänger in Allowlist sind, sendet AVA autonom; sonst Pflicht-Rückfrage via ask_user_choice. Beachtet outboundEnabled-Master-Schalter. Threading via References-Header.

_Parameter:_
- `messageId: string` (required) — ID der weiterzuleitenden Mail.
- `to: array` (required) — Empfängerliste (mindestens einer).
- `text: string` — Optionaler Begleittext, wird vor dem Forward-Quote eingefügt.

### `mail_get_message`

_Datei:_ `services/desktop/src/main/agent/tools/mail.ts`

Liefert die vollständige Mail inklusive Body-Text und Anhangs-Texten (PDFs werden extrahiert). Bilder sind als base64 enthalten, wenn das aktive Modell Vision unterstützt. Nutze das, nachdem du `mail_list_inbox` aufgerufen hast und der Nutzer mehr Details zu einer bestimmten Mail braucht oder du auf Basis des Inhalts handeln willst.

_Parameter:_
- `messageId: string` (required) — Die id aus mail_list_inbox.

### `mail_list_inbox`

_Datei:_ `services/desktop/src/main/agent/tools/mail.ts`

Listet die letzten eingegangenen Mails aus AVAs dediziertem Mail-Konto mit Absender, Betreff, Datum, Trust-Level (trusted/known/unknown) und AVAs Klassifikation (category, summary, suggestedAction). Standardmäßig nur ungelesene + nicht archivierte; mit `includeArchived: true` auch archivierte. Nutze das, wenn der Nutzer fragt 'was ist heute reingekommen', 'gibt es neue Mails', oder bevor du `mail_get_message` aufrufst um die richtige Mail-ID zu finden.

_Parameter:_
- `limit: integer` — Wie viele Mails maximal zurückgeben (Default 25, max 100).
- `includeArchived: boolean` — Wenn true, auch archivierte Mails listen. Default false.

### `mail_mark_read`

_Datei:_ `services/desktop/src/main/agent/tools/mail.ts`

Markiert eine Mail als gelesen (oder ungelesen, wenn `read: false`). Nutze das, wenn der Nutzer 'auf gelesen setzen' sagt oder du nach einer Triage-Aktion (Antwort, Archivierung) den unread-Counter aufräumen willst.

_Parameter:_
- `messageId: string` (required)
- `read: boolean` — Default true.

### `mail_reply`

_Datei:_ `services/desktop/src/main/agent/tools/mail.ts`

Antwortet auf eine bestimmte Mail. SICHERHEITSGATE: Wenn die Quellmail trustLevel 'trusted' hat, sendet AVA autonom; bei 'known' oder 'unknown' Pflicht-Rückfrage per ask_user_choice. Hängt die korrekten Threading-Header (In-Reply-To, References) an. Adressiert die From-Adresse der Quellmail; Re:-Präfix wird auto-prepended, wenn der Betreff es noch nicht hat.

_Parameter:_
- `messageId: string` (required) — Die ID der Quellmail.
- `text: string` (required) — Plain-Text-Antwort.

### `mail_send`

_Datei:_ `services/desktop/src/main/agent/tools/mail.ts`

Verschickt eine neue Mail von AVAs Konto. SICHERHEITSGATE: Wenn ALLE Empfänger in der Allowlist stehen, sendet AVA autonom. Wenn auch nur ein Empfänger nicht in der Allowlist ist, fragt das Tool den Nutzer per ask_user_choice. Outbound-Master-Schalter (`mail_account.outboundEnabled`) muss true sein, sonst lehnt das Tool ab. Threading via `inReplyTo` möglich, für Replies aber `mail_reply` bevorzugen.

_Parameter:_
- `to: array` (required) — Empfängerliste (mindestens einer).
- `cc: array`
- `subject: string` (required)
- `text: string` (required) — Plain-Text-Body. Markdown wird NICHT konvertiert.

## meta (2)

### `tool_load`

_Datei:_ `services/desktop/src/main/agent/tools/meta.ts`

Bring one or more tools into your live tool-list. The loaded tools are usable starting with the NEXT step of the current answer cycle — you can call `tool_load` and then immediately invoke the freshly-loaded tool in the same user turn. Tools stay loaded for the rest of this conversation, so you only need to load them once. Unknown names are reported back — don't retry blindly, do another `tool_search` with corrected keywords. Already-loaded tools and core tools are silently ignored (no-op).

_Parameter:_ keine.

### `tool_search`

_Datei:_ `services/desktop/src/main/agent/tools/meta.ts`

Search the full tool catalogue by keyword. Returns the top matches with a short summary per tool. Use this when you need a capability (e.g. "Notion update", "LinkedIn scrape", "voice transcribe") that isn't in your current tool list. After picking results, call `tool_load` with their names to bring them into your context — they'll be available starting NEXT turn. Already-loaded tools are excluded from the result so you don't waste a load on something already present. Query is case-insensitive, multi-word, scored highest on name then summary then full description.

_Parameter:_ keine.

## notion (11)

### `notion_connect_save_token`

_Datei:_ `services/desktop/src/main/agent/tools/notion.ts`

Persist the Notion Personal Access Token the user just pasted in chat, then validate it by making a /v1/users/me call. The token is stored encrypted in the OS keychain. Returns the workspace display name on success or a structured error message on failure (most common: 401 invalid token, 403 integration not added to any pages yet). Never echo the token back in your reply.

_Parameter:_
- `token: string` (required) — The Notion Personal Access Token, exactly as the user pasted it. Starts with ntn_ or secret_.

### `notion_connect_start`

_Datei:_ `services/desktop/src/main/agent/tools/notion.ts`

Begin connecting AVA to a Notion workspace. Returns the step-by-step instructions for the user to create a Personal Access Token (PAT) and share their workspace with the AVA integration. ALWAYS call this FIRST when the user asks to connect Notion — don't paraphrase the steps from memory, return them verbatim from this tool. After the user sends back their token, call `notion_connect_save_token` with the token string.

_Parameter:_ keine.

### `notion_create_page`

_Datei:_ `services/desktop/src/main/agent/tools/notion.ts`

Create a new Notion page. If the parent is a database, properties must match the database schema (call notion_introspect_database first to learn the property names + types). If the parent is a page, only `title` and `content` apply. `content` accepts Markdown (paragraphs, headings #/##/###, bullet/numbered lists, [ ]/[x] to-dos, > quotes, ```code blocks```, ---). Returns the created page ID + URL.

Property values: pass FLAT values keyed by property name. Examples: { 'Name': 'Eclat GmbH', 'Status': 'Lead', 'Tags': ['b2b'], 'Erstkontakt': '2026-05-18' }. DO NOT wrap in Notion-API objects. DO NOT JSON.stringify the whole properties object.

_Parameter:_
- `parentId: string` (required) — Database ID or Page ID under which to create the new page.
- `title: string`
- `properties: object` — Database-property values, keyed by the EXACT property name from the schema. Strings for title/rich_text/select/status, arrays for multi_select, ISO 8601 for date, numbers for number, booleans for checkbox.
- `content: string` — Markdown body content. Optional; can be added later via notion_update_page.

### `notion_delete_page`

_Datei:_ `services/desktop/src/main/agent/tools/notion.ts`

Archiviert (= soft-delete) eine Notion-Page. PROPOSE-AND-CONFIRM via ask_user_choice mit Page-Vorschau (Titel + Properties). Notion stellt die Page 30 Tage lang im Trash bereit; ein User-Mitglied (nicht die Integration) kann sie dort wiederherstellen.

Berechtigungs-Gotcha: gleiche Semantik wie notion_update_page — die Integration muss auf der DATENBANK verbunden sein, nicht nur auf der einzelnen Page. Sonst kommt HTTP 200 + keine Änderung zurück. Tool detected das per Verify-After und gibt eine klare Fehlermeldung mit Klick-Pfad.

Nutze für: stale leere Pages aufräumen (z. B. nach einem create-no-op), falsche Dubletten löschen, Test-Pages räumen. NICHT für CRM-Rows mit Daten — frag den User vorher explizit zur Bestätigung.

_Parameter:_
- `pageId: string` (required)
- `rationale: string` — Begründung, warum diese Page gelöscht werden soll (1 Satz).

### `notion_disconnect`

_Datei:_ `services/desktop/src/main/agent/tools/notion.ts`

Disconnect Notion. Clears the stored token from the OS keychain. The user will need to re-do the connect flow to reconnect.

_Parameter:_ keine.

### `notion_get_page`

_Datei:_ `services/desktop/src/main/agent/tools/notion.ts`

Load a single Notion page (or database row): its title, properties, and content body converted to Markdown. The page ID comes from notion_search or notion_query_database.

_Parameter:_
- `pageId: string` (required)

### `notion_introspect_database`

_Datei:_ `services/desktop/src/main/agent/tools/notion.ts`

Inspect the property schema of a specific Notion database — what columns it has, what type each is (title/select/multi_select/date/number/checkbox/status/…), and the available options for select-like columns. ALWAYS call this BEFORE notion_create_page OR notion_update_page targeting a database, so you can map the user's natural-language values ("Status auf erledigt") to the actual property name + the actual option name ("Verloren" or "Abgeschlossen" or whatever the schema actually offers). NEVER ask the user via ask_user_text what the field name or status option is — this tool returns that information directly.

_Parameter:_
- `databaseId: string` (required) — The Notion database ID (UUID or hyphenated UUID).

### `notion_list_databases`

_Datei:_ `services/desktop/src/main/agent/tools/notion.ts`

List all Notion databases the integration has access to. Returns id + title + URL per entry. ALWAYS call this as STEP 1 when the user wants to read OR modify anything in their Notion CRM — do not ask the user 'which database' first. Pick the most CRM-shaped result automatically (by title); only fall back to ask_user_choice if there are two equally plausible candidates. If you've already called this in the current turn / earlier, you may reuse the result; do not call it twice in a row.

_Parameter:_ keine.

### `notion_query_database`

_Datei:_ `services/desktop/src/main/agent/tools/notion.ts`

Run a structured query against a Notion database. Returns matching rows with simplified properties. Use this — NOT notion_search — when you need to find a specific row by its title or other property to then update it.

FINDING A ROW BY NAME (most common case): call notion_introspect_database FIRST to learn the exact name of the title-property. Then filter on that property. Required filter shape: {"property": "<exact-name>", "<type>": {"contains": "<wert>"}}. The wrapper key after `property` MUST match the property's actual type: `title` for title-fields, `rich_text` for text-fields, `select`/`status`/`multi_select` for option-fields, `date` for date-fields, `number` for numbers, `checkbox` for booleans.

WORKING EXAMPLES (assume schema has title-property called 'Name'):
  - Find by title-contains:   {"property":"Name","title":{"contains":"Kerstin"}}
  - Find by title-equals:     {"property":"Name","title":{"equals":"Kerstin Komarnicki"}}
  - Filter on status field:   {"property":"Status","status":{"equals":"Lead"}}
  - Filter on date:           {"property":"Created","date":{"on_or_after":"2026-01-01"}}
  - Combine with AND:         {"and":[ <filter1>, <filter2> ]}
  - Combine with OR:          {"or":[ <filter1>, <filter2> ]}

DO NOT SEND:
  - Empty filter `{}` — that's invalid in Notion; just omit the parameter to get all rows.
  - Type-wrapper without `property`: `{"title":{"contains":"X"}}` is missing the property name.
  - Stringified JSON for the filter — pass a real object.

If Notion still returns 400, the error response contains the actual property list of the database — read it, pick the correct property + wrapper, and retry. See https://developers.notion.com/reference/post-database-query-filter for the full spec.

Without `filter`, returns the most recently edited rows.

_Parameter:_ keine.

### `notion_search`

_Datei:_ `services/desktop/src/main/agent/tools/notion.ts`

Workspace-wide fuzzy search across all pages and databases AVA's Notion integration has been granted access to. Returns up to 25 hits with id, title, type (page/database), and URL.

Use this for general discovery ("was hat der User schon in Notion?"), NOT for finding a specific database row by name to update it. For that, use notion_list_databases + notion_query_database with a title-filter — search returns workspace-wide hits including sub-pages, notes, and linked-view shadows that can look like the row you want but aren't.

_Parameter:_
- `query: string` — Search string. Notion does fuzzy title + content matching. Empty string returns most-recent items.
- `limit: integer` — Max number of results (default 25, max 100).

### `notion_update_page`

_Datei:_ `services/desktop/src/main/agent/tools/notion.ts`

Update an existing Notion page: patch property values and/or append Markdown content to the bottom. `replaceContent` is not yet supported in this version.

MANDATORY PLAYBOOK when the user asks to change something in their Notion CRM ("setze Status von ESIS auf erledigt", "Follow-Up von Beckmann auf 2026"):
  1. notion_list_databases — find the target DB. Pick the most CRM-shaped one automatically (by title); only ask the user when two are equally plausible.
  2. notion_introspect_database — read the EXACT property names + the available Status/Select OPTIONS. You need this to map the user's word ("erledigt") to the actual option name ("Verloren" / "Disqualifiziert" / etc.).
  3. notion_query_database — find the row by title-filter (the person or company the user named).
  4. notion_update_page on THAT pageId with the mapped values.

DO NOT, under any circumstances, ask the user via ask_user_text for: which database, which field, which status option, which row, or to spell out a value they already gave you in plain German. ALL of that is discoverable via the four tools above. The only acceptable user-question during this flow is a single ask_user_choice when an option-name truly cannot be inferred from the schema (e.g. user says "hat sich erledigt" and the Status field offers both "Verloren" AND "Abgeschlossen" as plausible mappings — show those two options).

Finding the right pageId: DO NOT use notion_search for CRM-row lookups. It returns workspace-wide results including sub-pages, notes, and linked-database-views, so you can end up updating the wrong page that happens to share a title. Use notion_query_database with a title-filter instead. If you accidentally call notion_update_page on a non-row page, the tool throws a clear error and you should switch to the query_database flow.

Property values: pass FLAT values keyed by property name. Examples: { 'Status': 'Aktiv', 'Hotness': 'Cold', 'Follow-Up': '2026-07-16', 'Tags': ['lead', 'b2b'], 'Score': 42, 'Active': true }. DO NOT wrap in Notion-API objects like { 'Status': { 'status': { 'name': 'Aktiv' } } } — AVA does that mapping internally. DO NOT JSON.stringify the whole properties object — pass it as a real JSON object.

The tool has verify-after built in: if a property update silently no-ops or hits an invalid option, you get back a structured German error you can correct from. Lean on that instead of asking the user first.

IF THE ERROR MENTIONS "HTTP 200 aber serverseitig nichts gespeichert" OR "NICHT übernommen": Sag dem User UNMISSVERSTÄNDLICH, dass die Notion-Integration vermutlich nur auf der einzelnen Page verbunden ist, nicht auf der gesamten Datenbank. Schreibvorgänge erfordern Database-Level-Connection. Anleitung an den User: 'Bitte in Notion die Datenbank öffnen (nicht die Row) → oben rechts ⋯ → Connections → AVA verbinden. Danach nochmal versuchen.' Probiere NICHT, das durch Property-Name-Variation oder Retry zu umgehen — das ist eine Berechtigungsfrage, kein Mapping-Bug.

_Parameter:_
- `pageId: string` (required)
- `properties: object` — Partial map of property name → new value. Properties not listed remain unchanged.
- `appendContent: string` — Markdown to append at the end of the page body. Existing content stays put.

## obsidian (14)

### `obsidian_append_to_note`

_Datei:_ `services/desktop/src/main/agent/tools/obsidian.ts`

Append Markdown content to the end of an existing Obsidian note. Existing content stays untouched. To replace the whole note instead, use obsidian_replace_note.

_Parameter:_
- `path: string` (required) — Vault-relative path to the note (with .md).
- `content: string` (required) — Markdown to append at the end.

### `obsidian_connect_save_credentials`

_Datei:_ `services/desktop/src/main/agent/tools/obsidian.ts`

Persist the Obsidian Local-REST-API credentials and validate them by hitting the / endpoint. Stores baseUrl + apiKey encrypted in the OS keychain. Returns ok+vault-name on success, or a structured error.

_Parameter:_ keine.

### `obsidian_connect_start`

_Datei:_ `services/desktop/src/main/agent/tools/obsidian.ts`

Begin connecting AVA to an Obsidian vault. Returns step-by-step instructions for the user to install the 'Local REST API' community plugin, copy the API key + port, and send both back. ALWAYS call this FIRST when the user asks to connect Obsidian — don't paraphrase the steps from memory.

_Parameter:_ keine.

### `obsidian_create_note`

_Datei:_ `services/desktop/src/main/agent/tools/obsidian.ts`

Create a new Obsidian note. Title becomes the filename (auto-appended .md). Optional folder parameter places it in a sub-folder; omit for vault root. Content is Markdown. Returns the new note's path + content.

_Parameter:_
- `title: string` (required) — Title of the note. Used as filename. Slashes / backslashes will be replaced with spaces.
- `folder: string` — Optional vault-relative folder to place the note in. Empty = vault root.
- `content: string` — Markdown body of the note. Can include YAML frontmatter at the top if needed.

### `obsidian_delete_note`

_Datei:_ `services/desktop/src/main/agent/tools/obsidian.ts`

Löscht eine Obsidian-Note PERMANENT (kein Vault-Trash via REST-API). PROPOSE-AND-CONFIRM via ask_user_choice mit Path + Frontmatter-Vorschau + erste 3 Body-Zeilen. Bei explizitem User-Wunsch oder zum Aufräumen von Test/Stale-Notes.

ACHTUNG: Im Gegensatz zu Notion gibt es KEIN Soft-Delete — die Datei ist nach DELETE weg (es sei denn ein Backup-System wie Obsidian Sync / iCloud / Git-Repo fängt es ab). Frag den User bei Unsicherheit IMMER vor dem Aufruf — nicht erst der Confirm-Dialog vom Tool.

IF VERIFY-AFTER MELDET 'existiert immer noch': API-Key hat keinen Write-Scope. Gleiche Diagnose wie bei update_frontmatter.

_Parameter:_
- `path: string` (required)
- `rationale: string` — Begründung warum diese Note gelöscht werden soll (1 Satz).

### `obsidian_disconnect`

_Datei:_ `services/desktop/src/main/agent/tools/obsidian.ts`

Disconnect Obsidian. Clears the stored API key + base URL from the OS keychain. The user will need to re-do the connect flow to reconnect.

_Parameter:_ keine.

### `obsidian_get_note`

_Datei:_ `services/desktop/src/main/agent/tools/obsidian.ts`

Load a single Obsidian note by its vault-relative path. Returns the markdown content + frontmatter + timestamps. Path uses forward slashes and includes the .md extension (e.g., 'Daily Notes/2026-05-19.md').

_Parameter:_ keine.

### `obsidian_introspect_folder`

_Datei:_ `services/desktop/src/main/agent/tools/obsidian.ts`

Sampled bis zu 20 Notes (Default) in einem Vault-Ordner und gibt eine aggregierte Übersicht der Frontmatter-Konvention zurück: welche YAML-Keys gibt es überhaupt, was sind ihre Werte-Typen (string/number/boolean/array/date), wie oft kommen sie vor, was sind beispielhafte Werte. Nutze das VOR obsidian_update_frontmatter sobald du den Zielordner kennst, damit du die exakten Key-Namen (case-sensitive!) und die passenden Wert-Typen siehst. Vault-Schema gibt's konzeptionell nicht — das ist die nächstbeste Approximation.

Sonst-Strategie: Wenn du keinen Ordner kennst, frag den User. Heuristik für CRM: Ordner-Namen mit 'CRM', 'Kontakte', 'Pipeline', 'Deals' sind plausibel — wenn ein einzelner offensichtlich passt, nimm den ohne nachzufragen.

_Parameter:_ keine.

### `obsidian_list_notes`

_Datei:_ `services/desktop/src/main/agent/tools/obsidian.ts`

List files + sub-folders in a vault folder. Returns entries with `path` and `isFolder`. Pass an empty `folder` to list the vault root. Use this when the user wants to know what's in a specific folder.

_Parameter:_
- `folder: string` — Vault-relative folder path. Empty string or omitted = vault root. Forward slashes only.

### `obsidian_list_tags`

_Datei:_ `services/desktop/src/main/agent/tools/obsidian.ts`

Listet alle Tags im Vault mit der jeweiligen Anzahl Notes. Nutze das, wenn der User nach Tag-Strukturen fragt ('welche Tags hab ich überhaupt?') oder als Vorbereitung für eine Tag-basierte Filterung.

_Parameter:_ keine.

### `obsidian_replace_note`

_Datei:_ `services/desktop/src/main/agent/tools/obsidian.ts`

Replace the ENTIRE content of an Obsidian note with new Markdown. Existing content is deleted. Use append_to_note instead if you want to add to existing content.

_Parameter:_
- `path: string` (required)
- `content: string` (required)

### `obsidian_search`

_Datei:_ `services/desktop/src/main/agent/tools/obsidian.ts`

Full-text search across the Obsidian vault. Returns up to 25 hits with file path (id), title, and a short context snippet. Use when the user references a note by content or topic.

_Parameter:_
- `query: string` (required) — Search string. Plugin does substring matching.
- `limit: integer` — Max number of results (default 25, max 100).

### `obsidian_search_by_tag`

_Datei:_ `services/desktop/src/main/agent/tools/obsidian.ts`

Listet alle Notes mit einem bestimmten Tag. Tag mit oder ohne führendes # akzeptiert. Schneller + zielsicherer als obsidian_search, wenn der User Tag-basiert filtern will ('zeig mir alle #lead-Notes', 'welche Notes haben #b2b?'). Falls du nicht sicher bist welche Tags es überhaupt gibt: erst obsidian_list_tags.

_Parameter:_ keine.

### `obsidian_update_frontmatter`

_Datei:_ `services/desktop/src/main/agent/tools/obsidian.ts`

Update YAML-frontmatter fields of an Obsidian note. Body content stays untouched. Use this when the user wants to change a CRM-style field that lives in the YAML header (Status, Stage, Owner, Follow-Up, Tags, …).

Playbook for CRM-style requests ('setze Status von X-Note auf Aktiv', 'Follow-Up von Beckmann auf 2026'):
  1. obsidian_search ODER obsidian_list_notes — finde die Note. Lieber `list_notes` mit Folder-Pfad als Workspace-Suche, weil letzteres auch Body-Treffer einbezieht.
  2. obsidian_get_note — lies das aktuelle Frontmatter, damit du die EXAKTEN Key-Namen (case-sensitive!) und das aktuelle Wert-Schema (string vs. array vs. bool) siehst.
  3. obsidian_update_frontmatter mit den geänderten Keys.

Property values: pass FLAT values. Examples: { 'Status': 'Aktiv', 'Stage': 'Lead', 'Follow-Up': '2026-07-16', 'Tags': ['b2b','lead'], 'Hotness': 'Cold' }. NICHT als YAML-String wrappen.

IF VERIFY-AFTER FAILS mit 'nicht übernommen': Der API-Key hat vermutlich nur Read-Scope. User-Anweisung: 'Bitte in Obsidian → Settings → Local REST API prüfen, ob der genutzte API-Key Write-Berechtigung hat. Falls nein, einen neuen Key mit vollem Scope erzeugen und in AVA neu hinterlegen.' NICHT durch Property-Variation retryen — Berechtigungsfrage.

_Parameter:_
- `path: string` (required)
- `properties: object` (required) — Map of frontmatter-key → new value. Keys not listed remain unchanged.

## Ollama (lokale LLM) (4)

### `ollama_delete_model`

_Datei:_ `services/desktop/src/main/agent/tools/ollama.ts`

Löscht ein installiertes Ollama-Modell, um Speicherplatz freizugeben. Verwende das Tool nur, wenn der Nutzer ein konkretes Modell zum Löschen benennt. Setzt voraus, dass der Daemon bereit ist.

_Parameter:_
- `model: string` (required) — Modellname inklusive Tag, z. B. `qwen2.5:7b`.

### `ollama_pull_model`

_Datei:_ `services/desktop/src/main/agent/tools/ollama.ts`

Lädt ein Ollama-Modell anhand seines Namens herunter (z. B. `qwen2.5:7b`, `llama3.2:3b`). Der Download läuft asynchron im Hintergrund weiter, das Tool kehrt sofort zurück, sobald der Transfer gestartet ist. Nutze danach `ollama_status`, um den Fortschritt zu prüfen. Setzt voraus, dass der Ollama-Daemon bereit ist.

_Parameter:_
- `model: string` (required) — Modellname inklusive Tag, z. B. `qwen2.5:7b`.

### `ollama_restart`

_Datei:_ `services/desktop/src/main/agent/tools/ollama.ts`

Startet den lokalen Ollama-Daemon neu (Stop + Start). Nützlich, wenn der Daemon hängt, ein Modell-Pull fehlgeschlagen ist oder der Nutzer 'Ollama neu starten' verlangt.

_Parameter:_ keine.

### `ollama_status`

_Datei:_ `services/desktop/src/main/agent/tools/ollama.ts`

Liefert den Status des lokalen Ollama-Daemons: Zustand (idle / starting / ready / error), installierte Modelle und fehlende Pflichtmodelle. Nutze das Tool, wenn der Nutzer fragt, ob Ollama läuft, welche Modelle vorhanden sind oder warum die KI-Antworten ausbleiben.

_Parameter:_ keine.

## Producer (Hintergrund-Services) (2)

### `producers_logs_tail`

_Datei:_ `services/desktop/src/main/agent/tools/producers.ts`

Liest die jüngsten Logzeilen eines Producers aus dem Ring-Puffer. Nutze das Tool, wenn der Nutzer den Grund für einen Fehlerzustand sehen will (z. B. „was sagt structured-content?“). Liefert eine begrenzte Anzahl Zeilen mit Zeitstempel und stdout/stderr-Kanal.

_Parameter:_ keine.

### `producers_status`

_Datei:_ `services/desktop/src/main/agent/tools/producers.ts`

Liefert den Status aller lokal laufenden Producer (z. B. company-profile, structured-content, company-publication, master-data). Pro Producer: Name, Zustand (idle / migrating / starting / ready / error / stopping / not_installed), TCP-Port, PID, letzte Fehlermeldung. Nutze das Tool, wenn der Nutzer fragt, ob ein Producer läuft oder warum eine Verarbeitungs-Stage hängt.

_Parameter:_ keine.

## Erreichbarkeit (externe Quellen) (2)

### `reachability_probe_now`

_Datei:_ `services/desktop/src/main/agent/tools/reachability.ts`

Erzwingt sofort eine neue HEAD-Probe gegen alle externen Quellen (unternehmensregister.de, handelsregister.de) und liefert den aktualisierten Status zurück. Nutze das Tool, wenn der Nutzer „prüf jetzt mal nach“ verlangt oder wissen will, ob ein zuvor gemeldeter Ausfall vorbei ist. Eine Probe kann bis zu 120 s dauern.

_Parameter:_ keine.

### `reachability_status`

_Datei:_ `services/desktop/src/main/agent/tools/reachability.ts`

Liefert den aktuellen Erreichbarkeits-Status der externen Quellen (unternehmensregister.de, handelsregister.de). Pro Quelle Status (reachable / unreachable / unknown), Zeitpunkt der letzten Prüfung, Latenz und Fehlerursache. Nutze das Tool, wenn der Nutzer fragt, ob eine der Quellen gerade erreichbar ist oder warum Producer hängen.

_Parameter:_ keine.

## scheduler (4)

### `schedule_cancel`

_Datei:_ `services/desktop/src/main/agent/tools/scheduler.ts`

Stoppt einen wiederkehrenden Job sofort. Idempotent — ein bereits gestoppter Job bleibt gestoppt. Kein Confirm-Gate, weil trivial reversibel (Job kann neu erstellt werden). Nutze `schedule_list` zuerst, wenn du die id nicht hast.

_Parameter:_
- `jobId: string` (required)

### `schedule_list`

_Datei:_ `services/desktop/src/main/agent/tools/scheduler.ts`

Listet alle wiederkehrenden Jobs, die AVA aktuell für den Nutzer geplant hat (active, paused, expired, completed, cancelled). Zeigt pro Job: id, label, kind, intervalMinutes, nextRunAt, expiresAt, runsCompleted, runsCap, status, lastError. Nutze das, wenn der Nutzer fragt 'was hast du gerade alles laufen' oder bevor du `schedule_cancel` aufrufst, um die richtige id zu finden.

_Parameter:_ keine.

### `schedule_mail_loop`

_Datei:_ `services/desktop/src/main/agent/tools/scheduler.ts`

Plant eine wiederkehrende Mail an einen oder mehrere Empfänger. Tool fragt SELBST via ask_user_choice nach Bestätigung. Sicherheits-Regeln:
- Min Intervall ${MIN_INTERVAL_MINUTES} min
- Max Laufzeit ${MAX_LIFETIME_MS / 1000 / 60 / 60 / 24} Tage (Default 24h)
- Max ${MAX_RUNS_CAP} Runs pro Job
- Max ${ACTIVE_JOB_CAP} parallele Jobs
- ALLE Empfänger müssen in der Mail-Allowlist stehen (sonst hätten wir einen Spam-Loop-Vektor)
- outboundEnabled-Master-Schalter im Mail-Konto muss true sein

Wenn die erste Mail SOFORT raus soll: `firstRunImmediately: true`. Sonst läuft der erste Send nach `intervalMinutes`. Per Default expiriert der Job nach 24h — der User kann via `expiresInHours` (max 168 = 7 Tage) verlängern.

Stoppen: `schedule_cancel` mit der id aus diesem Tool oder via `schedule_list`. Bei "stopp"/"stop"/"abbrechen"/"hör auf" vom User SOFORT cancel aufrufen.

_Parameter:_ keine.

### `schedule_reminder`

_Datei:_ `services/desktop/src/main/agent/tools/scheduler.ts`

Erinnerung zu einer bestimmten Uhrzeit (Datum + Zeit). Bei Fälligkeit erstellt AVA eine Meldung unter "Meldungen" mit Headline=label und Body=prompt, plus eine OS-Notification. Use-Case: "Erinnere mich am 28. Mai 14:00, Sascha Kluck anzurufen, Tel +49 174 ...". Standard ist einmalig (runsCap=1). Wenn der User explizit "jeden Montag", "wöchentlich", "täglich" sagt → recurring via intervalMinutes + runsCap >1.

WICHTIG: prompt ist die KOMPLETTE Reminder-Botschaft die der User später sehen wird — inkl. Kontext (Name, Telefon, Hintergrund) den der User dir gerade gegeben hat. Schreib sie so, dass der User in 2 Wochen ohne dich nochmal kontaktieren zu müssen alles weiß. Maximal 500 Zeichen.

dueAt: ISO-8601-Datetime in Lokalzeit (z. B. "2026-05-28T14:00:00"). Muss in der Zukunft liegen, max 1 Jahr voraus. Tool fragt SELBST via ask_user_choice nach Bestätigung. Cancel via schedule_cancel.

_Parameter:_ keine.

## self-correction (1)

### `report_self_correction`

_Datei:_ `services/desktop/src/main/agent/tools/self-correction.ts`

Meldet einen gefundenen Workaround nach einem Tool-Error an die lokale Telemetrie. Nutze das IMMER, wenn du in dieser Konversation:
  (a) ein Tool aufgerufen hast, das mit Fehler returnte,
  (b) danach einen alternativen Weg gefunden hast, der zum Erfolg führte.

Beispiel: crm_create_hubspot_contact mit inline-Assoc failed wegen falscher Type-ID → ohne Assoc anlegen + danach crm_associate_hubspot_objects funktioniert. Das ist genau der Fall den der Entwickler sehen will, um die Type-ID-Tabelle im Code zu fixen.

Felder kompakt halten, Telemetrie nicht zum Roman ausbauen. Felder:
  - attemptedTool: Name des Tools das gefailed hat (z. B. 'crm_create_hubspot_contact')
  - failedReason: 1-3 Sätze WAS schief lief
  - workaround: 1-3 Sätze WIE du es trotzdem hingekriegt hast
  - suggestedCodeFix (optional): wo im Code vermutlich der eigentliche Fix sitzen müsste
  - rawErrorPreview (optional): die Original-Fehler-Message (max 400 Zeichen, gekürzt)

Die Daten bleiben LOKAL auf der Maschine des Nutzers (kein Cloud-Upload) und werden in Settings → Verlauf → Selbstkorrekturen sichtbar.

_Parameter:_
- `attemptedTool: string` (required)
- `failedReason: string` (required)
- `workaround: string` (required)
- `suggestedCodeFix: string`
- `rawErrorPreview: string`

## skills (5)

### `skill_create`

_Datei:_ `services/desktop/src/main/agent/tools/skills.ts`

Create a new skill OR overwrite an existing user-scope skill. ALWAYS prompts the user for inline confirmation via a Ja/Nein dialog BEFORE writing — the user sees the proposed frontmatter + body preview. Use when the user says 'merk dir das als Skill', 'leg dafür einen Skill an', or after they've taught you a procedure you'd want to re-use. Workspace-scope skills can NOT be overwritten here.

_Parameter:_ keine.

### `skill_delete`

_Datei:_ `services/desktop/src/main/agent/tools/skills.ts`

Delete a user-scope skill after explicit user confirmation. Workspace-scope skills cannot be deleted from here. Trust state is cleared along with the file.

_Parameter:_
- `name: string` (required) — Kebab-case name of the skill.

### `skill_get`

_Datei:_ `services/desktop/src/main/agent/tools/skills.ts`

Load the full content of one skill — frontmatter + markdown body. Use BEFORE proposing an update so you have the exact existing body to diff against.

_Parameter:_
- `name: string` (required) — Kebab-case name of the skill (as returned by skill_list).

### `skill_list`

_Datei:_ `services/desktop/src/main/agent/tools/skills.ts`

List all skills available to AVA (user-scope + workspace-scope). Returns name, description, language, b2b-scope, enabled-state and trust-state. Use this when the user asks 'welche Skills hast du?' or before suggesting to create a new one (avoid duplicates).

_Parameter:_ keine.

### `skill_search`

_Datei:_ `services/desktop/src/main/agent/tools/skills.ts`

Substring-search across skill names + descriptions + bodies. Returns up to 10 hits sorted by relevance. Use this at the start of EVERY turn where the user asks AVA to do something repeatable ('mach mir ein …', 'wie immer …', 'analysiere das Profil') — there might already be a skill for it.

_Parameter:_
- `query: string` (required) — Search term (case-insensitive).

## App-Updates (4)

### `updater_check`

_Datei:_ `services/desktop/src/main/agent/tools/updater.ts`

Prüft bei GitHub Releases, ob eine neuere Version verfügbar ist. Nutze das Tool, wenn der Nutzer 'Update prüfen' oder 'gibt es eine neue Version' verlangt. Liefert anschließend den aktualisierten Status zurück. Funktioniert nur in der gepackten App; im Entwicklungsmodus passiert nichts.

_Parameter:_ keine.

### `updater_download`

_Datei:_ `services/desktop/src/main/agent/tools/updater.ts`

Lädt das verfügbare Update im Hintergrund herunter (.dmg auf macOS, .exe auf Windows). Setzt voraus, dass `updater_check` zuvor ein Update gemeldet hat. Der Download läuft asynchron; Fortschritt über `updater_status` abfragen. Installation passiert separat über `updater_install`.

_Parameter:_ keine.

### `updater_install`

_Datei:_ `services/desktop/src/main/agent/tools/updater.ts`

Installiert das heruntergeladene Update und startet die App neu. Setzt voraus, dass `updater_download` abgeschlossen ist (`updater_status` meldet `downloaded: true`). Achtung: der Aufruf beendet die App innerhalb weniger Sekunden, die Antwort kommt möglicherweise nicht mehr beim Nutzer an.

_Parameter:_ keine.

### `updater_status`

_Datei:_ `services/desktop/src/main/agent/tools/updater.ts`

Liefert den Status des Auto-Updaters: aktuelle Version, neueste bekannte Version, ob ein Update verfügbar ist und ob es bereits heruntergeladen wurde. Nutze das Tool, wenn der Nutzer fragt, ob ein Update verfügbar ist oder welche Version aktuell läuft.

_Parameter:_ keine.

## Spracherkennung (4)

### `voice_delete_model`

_Datei:_ `services/desktop/src/main/agent/tools/voice.ts`

Löscht das heruntergeladene Sprachmodell, um Speicherplatz freizugeben. Der `model`-Parameter ist optional und wird derzeit ignoriert; die App löscht das aktive Modell. Nach dem Löschen muss `voice_download_model` aufgerufen werden, bevor Diktat wieder funktioniert.

_Parameter:_
- `model: string` — Optionaler Modellname. Derzeit ignoriert; die App löscht das aktive Modell.

### `voice_download_model`

_Datei:_ `services/desktop/src/main/agent/tools/voice.ts`

Lädt das Standard-Sprachmodell für die Diktatfunktion herunter (mehrere hundert MB). Der `model`-Parameter ist optional und wird derzeit ignoriert; die App nutzt das per Umgebungsvariable konfigurierte Standardmodell. Nutze das Tool, wenn `voice_status` 'model-missing' meldet. Der Download läuft im Hintergrund weiter; Fortschritt über `voice_status` abfragen.

_Parameter:_ keine.

### `voice_install_binary`

_Datei:_ `services/desktop/src/main/agent/tools/voice.ts`

Installiert das whisper.cpp-Binary (über Homebrew auf macOS, via offiziellem Download auf Windows, Paketmanager-Hinweis auf Linux). Nutze das Tool, wenn der Nutzer die Spracherkennung erstmals einrichten möchte und `voice_status` 'binary-missing' meldet. Kann mehrere Minuten dauern.

_Parameter:_ keine.

### `voice_status`

_Datei:_ `services/desktop/src/main/agent/tools/voice.ts`

Liefert den Status der Spracherkennung: ist das whisper.cpp-Binary installiert, ist das Sprachmodell heruntergeladen, läuft ein Download. Nutze das Tool, wenn der Nutzer fragt, ob Diktat / Spracheingabe einsatzbereit ist.

_Parameter:_ keine.
