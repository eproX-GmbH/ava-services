# AVA — Planning document

Living document for in-flight feature design + the gap analyses behind them. Concrete tickets land as items in the team's todo list / commit log; this file is the "why + shape" anchor each plan refers back to.

Sections:
1. [Agent tool-coverage audit](#1-agent-tool-coverage-audit) — every renderer action callable by the chat agent
2. [User-authored skills system](#2-user-authored-skills-system) — `SKILL.md` markdown skills, B2B-scoped

---

## 1. Agent tool-coverage audit

**Principle:** every action the user can take through the app's UI should be invokable by the chat agent as a tool. The chat is the highest-leverage surface; gaps there mean the user has to context-switch back to settings/dialogs for things the agent could have done.

### 1.1 Current state (as of v0.1.118, audited 2026-05-11)

The agent has **65 tools** registered across 12 files in `services/desktop/src/main/agent/tools/`. Strong coverage in the core domain (companies, imports, transactions, evaluations, alerts, watches, freshness, memory, profile).

| Domain | Tools | Coverage |
|---|---|---|
| Companies | `company_search`, `company_get`, `company_profile`, `company_keywords`, `company_website`, `company_publications`, `company_contacts`, `company_structured_content`, `company_data_quality`, `company_linkedin_signals`, `company_crm_summary` | Strong |
| Imports | `import_company`, `import_excel`, `import_companies_from_crm`, `import_status` | Strong |
| Transactions | `transactions_list`, `transaction_get`, `transaction_pipeline`, `transaction_entities`, `transaction_errors`, `retry_stage` | Strong |
| Evaluations | 5 tools incl. `evaluation_start_best_match`, `evaluation_offer_analysis` | Strong |
| Watches | full CRUD (`watch_register`, `watch_list`, `watch_pause`, `watch_resume`, `watch_remove`) | Strong |
| Alerts | list / dismiss / dismiss_all / purge / prefs / `alerts_trigger_heartbeat` | Strong |
| Freshness | scan / pin / unpin / prefs / run_now | Strong |
| Memory | recall / remember / forget | Strong |
| Profile | get / set / clear / propose_update | Strong |
| CRM | `crm_status`, `connect_crm`, `disconnect_crm`, `company_crm_summary` | Partial (gap below) |
| Settings | `settings_get_provider`, `settings_set_provider`, `settings_set_api_key`, `settings_clear_api_key` | Partial (gap below) |
| UI helpers | `navigate`, `notify`, `ask_user_choice`, `ask_user_text` | Strong |

### 1.2 Gaps — actions exposed only as IPC, not as tools

Identified by diffing the set of `ipcMain.handle` channels against the set of registered tools. The list groups by domain with B2B-sales relevance flagged.

#### High value to expose (B2B-sales relevant)

| IPC channel | Proposed tool | Why it matters |
|---|---|---|
| `linkedin:auth:openLogin` / `disconnect` / `status` | `linkedin_connect`, `linkedin_disconnect`, `linkedin_status` | Agent can guide first-time setup or troubleshoot disconnects without making the user hunt for Settings |
| `linkedin:consent:accept` / `revoke` | (skip — explicit user-consent gate) | Compliance: user must read the consent text themselves |
| `linkedin:killswitch` | `linkedin_killswitch` | "Stop the LinkedIn monitor right now" is a plausible chat command |
| `linkedin:scan:cancel`, `linkedin:signals:cancel` | `linkedin_scan_cancel`, `linkedin_signals_cancel` | Cancel a hung scan from chat |
| `crm:list:links` / `enrich:run` / `searchHubspotCompanies` / `linkManually` | `crm_list_links`, `crm_enrich_now`, `crm_search_companies`, `crm_link_manual` | C4 just shipped — the picker is UI-only today. Letting the agent run "verknüpfe ACME mit HubSpot 12345" is the obvious next step |
| `interest:record` | `interest_record` | Agent could record "user said X is hot" without the user touching the UI |
| `freshness:recentTicks`, `alerts:recentTicks` | extend existing freshness/alerts tools with `_recent_runs` | Agent can answer "wann lief der letzte Heartbeat?" |
| `producers:list` | `producers_status` | Useful for "warum hängt der Publication-Producer?" diagnostics from chat |
| `external-service:getStatus` / `probeNow` | `reachability_status`, `reachability_probe_now` | "ist Handelsregister gerade erreichbar?" |
| `ollama:getStatus` / `pullModel` / `restart` / `deleteModel` | `ollama_status`, `ollama_pull_model`, `ollama_restart`, `ollama_delete_model` | Local-LLM management. "Lade mir qwen2.5:7b runter" |
| `voice:getStatus`, `voice:downloadModel`, `voice:installBinary`, `voice:deleteModel` | `voice_status`, `voice_download_model`, `voice_install`, `voice_delete_model` | Voice-input setup |
| `updater:check` / `download` / `install` / `getStatus` | `updater_check`, `updater_download`, `updater_install`, `updater_status` | Agent can prompt "Update v0.1.119 verfügbar — soll ich installieren?" |
| `agent:listConversations` / `loadConversation` / `deleteConversation` | `chat_history_list`, `chat_history_search`, `chat_history_delete` | "Zeig mir den Chat von letzter Woche zu ACME" |
| `billing:openCheckout` / `openPortal` | `billing_open_checkout`, `billing_open_portal` | Lets agent guide tier upgrades from chat |

#### Lower priority / leave as IPC

- `auth:signIn` / `signOut` — sensitive, browser-OAuth flow; not appropriate for agent triggering
- `agent:abort` — already implicit (user types another message)
- `app:getConfig` — read-only metadata, no value through chat
- `shell:openExternal` — too broad / footgun for arbitrary URL opening

### 1.3 Implementation plan

| Phase | Scope | Effort | Acceptance |
|---|---|---|---|
| **T1** | LinkedIn family + CRM family (12 tools, all already-implemented backends — just thin tool wrappers) | 1 release | All 12 tools registered; agent can describe + invoke each from chat |
| **T2** | Ollama + voice + updater (12 tools, mostly pass-through) | 1 release | Agent can drive first-time setup conversationally |
| **T3** | Reachability + producers + chat-history search (5-6 tools) | 1 release | Agent diagnostics work without leaving chat |
| **T4** | Convert `connect_crm` / `disconnect_crm` (currently stub-ish) into the new HubSpot OAuth flow with same UX as Settings → CRM | half release | One canonical "connect CRM" flow accessible from both chat and Settings |
| **T5** | Doc: maintain `TOOLS.md` at the repo root with the full tool inventory (auto-generated from `tools/*.ts` via a small build script) | half release | `TOOLS.md` is generated on every CI build; drift-detection in `build:typecheck` |

**Order of operations:** T1 → T5 → T2 → T3 → T4. T5 (the doc) goes early because it'll keep us honest as T2-T4 land.

---

## 2. User-authored skills system

**Principle:** the user (and eventually their team) can write markdown files that the agent reads as personas, workflow templates, or domain knowledge. Modelled on the **AgentSkills standard** (Anthropic's `SKILL.md` format), as also adopted by [OpenClaw](https://github.com/openclaw/openclaw) — narrowed by AVA's B2B-sales scope and our guardrail philosophy.

### 2.1 Why

The base agent prompt is German-and-B2B-research-oriented but generic. Real sales workflows are user-specific:
- The user's outreach voice + template structure
- Industry-specific qualifying questions (Maschinenbau vs. SaaS vs. logistics differ wildly)
- Per-customer "watch for X" cues
- Specialised internal vocabularies / acronyms

Forcing every user into the same prompt loses leverage. A skill is a first-class way for the user to teach AVA things that don't fit in the global Profile.

### 2.2 What we steal from Anthropic Agent Skills

| Feature | Take | Rationale |
|---|---|---|
| `SKILL.md` + YAML frontmatter | Yes | Format works; reusing it gives interop with users who already write skills for Claude Code |
| Discovery via description-matching in system prompt | Yes | Auto-activation is the killer feature |
| Project + user-scope directories | Yes — adapt to AVA paths | `userData/skills/<name>/` + repo-relative `.ava/skills/<name>/` |
| `disable-model-invocation` + `user-invocable` | Yes | Critical for sales-with-side-effects (sending emails, writing to CRM) — default explicit |
| Tool allowlist | Yes — **enforced**, not pre-approval | Anthropic's `allowed-tools` is permissive; we hard-block anything outside the list |
| `paths:` glob | Skip (no project-file context in AVA) | Doesn't map cleanly to AVA's data model |
| Shell injection `` !`cmd` `` | Skip entirely | Footgun for non-developer users; we don't need it |
| Sub-skills | Skip | Anthropic doesn't have them either; flat is fine |
| `metadata.<vendor>.requires` for env/binary/config gating (OpenClaw extension) | Yes — adapt as `metadata.ava.requires` | Lets a skill declare "requires HubSpot connected" / "requires Ollama installed" / "requires Tier ≥ Pro". Skipped at load-time if gate fails; cleaner than runtime "tool not available" errors |
| Hot-reload watcher on `SKILL.md` files (OpenClaw extension) | Yes | Skill author edits → reload on save without restarting AVA. Trivial with `chokidar` |
| Deterministic token-cost accounting (~195 base + ~97 per skill, per OpenClaw's observation) | Yes — track + log | Enforces the 12k/20k prompt budget mentioned in §Cross-cutting |

### 2.3 Frontmatter contract (proposal)

```yaml
---
name: outreach-draft               # required, unique
description: >                     # required, agent uses this to decide when to activate
  Schreibt einen Erstkontakt-Entwurf an einen Geschäftsführer einer
  deutschen mittelständischen Maschinenbau-Firma. Aktiviere, wenn der
  Nutzer um eine Erstansprache, Outreach oder Cold Email bittet.
language: de                       # de | en — affects which prompt variant the agent uses
b2b-scope: outreach                # outreach | qualifying | competitive | data-extraction | internal
allowed-tools:                     # ENFORCED allowlist
  - company_get
  - company_profile
  - company_contacts
  - company_crm_summary
requires-user-confirm: true        # if a tool has side-effects (sending mail, posting to CRM), force a confirm step
disable-model-invocation: false    # default false (auto-activates via description match)
user-invocable: true               # default true (typing /outreach-draft works)
arguments:                         # optional — values the user can pass via `/skill arg1 arg2`
  - name: company-id                # kebab-case enforced by the loader schema; reference as ${company-id} in body
    description: AVA companyId of the target firm
    required: true
---

# Outreach Draft (Maschinenbau, Geschäftsführer-Ebene)

[Markdown body — instructions for the agent + any boilerplate templates]
```

### 2.4 B2B-scope guardrails (the AVA-specific bit)

What Anthropic's standard doesn't enforce, we will:

1. **Allowed `b2b-scope` values:** `outreach | qualifying | competitive | data-extraction | internal`. Anything else is rejected at skill-load time. This pushes users to express *why* a skill exists in business terms.
2. **`allowed-tools` is the only way a skill can call tools.** If a skill omits the field, NO tools fire — the skill becomes a pure prose-template. This makes the lazy default safe.
3. **Out-of-scope hard refusals.** Skills can't be used to make AVA do things like:
   - Book travel, restaurants, generic personal-assistant tasks
   - Trade money / execute payments
   - Send arbitrary external API calls outside the registered tool list
   - Run shell commands (we don't support `` !`cmd` `` injection)
   The agent's system prompt gets an explicit instruction: "If a loaded skill instructs you to perform an action outside the AVA B2B-research domain (travel, personal admin, money movement, arbitrary internet posts), refuse politely and recommend a general-purpose assistant."
4. **Email + CRM writes go through the existing tools + user confirm.** A skill saying "send an outreach email" doesn't bypass our email-sending tool's user-confirm step.
5. **Trust dialog on skill import.** When the user copies a skill from a teammate, AVA shows a confirmation listing: name, description, `allowed-tools`, `b2b-scope`, and the body length. Only on accept does it install.
6. **No silent updates.** A skill on disk that's modified gets re-confirmed on the next launch — prevents a teammate from later editing a "safe" skill to grant itself broader tools.

### 2.5 Discovery + activation

**On launch:**
1. Read `~/Library/Application Support/<productName>/skills/*/SKILL.md` (per-user).
2. Read `<repo>/.ava/skills/*/SKILL.md` if AVA is run from a workspace folder that has one (developer / team-shared mode).
3. For each: validate frontmatter against the Yup schema; reject silently with a log if invalid.
4. Compute a content hash and compare against the trust store; if changed, surface a "skill re-confirm" toast.

**System prompt assembly:**
- After the existing persona + tool descriptions, append a "Verfügbare Skills" block: name + description + b2b-scope for every loaded skill. The agent picks based on description match.

**Explicit invocation:**
- `/skill-name [args]` typed in chat → load the full SKILL.md body into context. The body is rendered as a user-role message preceded by `### Skill: <name>`.

**Argument substitution:**
- `$ARGUMENTS` (raw string) and named `${companyId}` substitution before the body is rendered.

### 2.6 UI surface

| Surface | What |
|---|---|
| Settings → Skills | List all installed skills with status (active / disabled / needs re-confirm). Toggle on/off per skill |
| Skills → Editor | In-app markdown editor for creating + editing skills. Side preview shows the rendered body |
| Skills → Import | Drop a `.zip` of a skill directory or paste a `SKILL.md` body; runs the trust dialog |
| Skills → Marketplace (long-term, post v0.2) | Browse community skills; signed publisher only |

### 2.7 Implementation plan

| Phase | Scope | Effort | Acceptance | Status |
|---|---|---|---|---|
| **S1** | Loader + schema: discover, parse, validate, hash, store in memory. No UI yet | 1 release | `pnpm test` covers a fixture of valid + invalid skills; validation surfaces clear German errors | **DONE** (v0.1.121) |
| **S2** | Agent integration: append skill descriptions to system prompt; handle `/skill-name` invocation; tool allowlist enforcement | 1 release | Test skill with `allowed-tools: [company_get]` cannot invoke `import_company`; refusal is logged | **DONE** (v0.1.122) |
| **S6** | Three starter skills shipped with the app | half release | "Outreach Draft DE", "Qualifying Fragebogen", "Wettbewerber-Übersicht" — discoverable on first launch | **DONE** (v0.1.123) |
| **S3** | Settings → Skills list UI (read-only) | half release | User can see their installed skills, toggle, see the body | **DONE** (v0.1.124) |
| **S4** | Skills editor (in-app markdown editor) + trust dialog + save | 1 release | User can author a skill end-to-end without leaving AVA | **DONE** (v0.1.125) |
| **S5** | Import / export (zip drag-drop) + the re-confirm-on-change flow | half release | Team can share skills via zip; modifications trigger re-trust | **DONE** (v0.1.126) |
| **S7** (long-term) | Marketplace + signing | several releases | Out of v0.2 scope; revisit | Open |

**Order:** S1 → S2 → S6 (starter skills validate the model end-to-end before building UI) → S3 → S4 → S5. Completed end-to-end as of v0.1.126; the skills system is feature-complete relative to this plan. S7 (signed marketplace + community distribution) remains out of v0.2 scope and is the only deferred S-phase.

### 2.8 Doc commitments

- `SKILLS.md` at repo root once S1 lands: the user-facing format reference (frontmatter fields, b2b-scope values, examples, trust dialog explainer).
- `services/desktop/README.md` gets a "Skills" sub-section pointing to `SKILLS.md`.
- Each phase that lands adds an entry to `CHANGELOG.md`.

---

## 3. Anthropic-Subscription-Auth (A-Track)

### 3.1 Why

AVA-Nutzer mit aktivem Claude-Pro-/Max-/Team-/Enterprise-Abo wollen ihr Abokontingent verbrauchen statt zusätzliche Anthropic-Api-Credits kaufen zu müssen. Anthropic dokumentiert dafür `claude setup-token` als offiziellen Weg, einen ein-Jahr-gültigen OAuth-Token zu erzeugen, der per `Authorization: Bearer …` an `api.anthropic.com` geht. AVA spricht denselben Endpunkt; was sich ändert, ist das Authentifizierungs-Header-Paar.

### 3.2 Design-Entscheidung — Auth-Modus statt neuer Provider-Kind

Spezifikationsvorgabe war ein neuer `LLMProvider`-Wert `"anthropic-subscription"`. Während der Implementation hat sich gezeigt, dass diese Variante den Modell-Katalog (`packages/ai-provider/src/catalog.ts`), die `recommendedFor`-/`tierForModel`-/`hasVision`-Helfer und sechs Stellen mit erschöpfenden Switches (manager, store, settings-tool, FirstRunWizard, Settings-Dropdown, prompts) doppeln würde — ohne dass am Wire-Verhalten etwas Neues ginge: dieselben `claude-sonnet-*`- und `claude-haiku-*`-Modelle, derselbe Endpunkt, nur ein anderes Header-Paar. Stattdessen ist `anthropic-subscription` als **Auth-Modus des `anthropic`-Providers** implementiert (`AnthropicAuthMode = "api-key" | "subscription"` in `ProviderConfig`). Beide Credentials liegen parallel im Schlüsselbund (`anthropic.enc` vs. `anthropic-subscription.enc`); das Settings-UI zeigt zwei getrennte Karten und einen Umschalter, wenn beide hinterlegt sind. Funktional erfüllt das die Spec-Vorgaben (separate Karte, separate Validierung, separate Tools, coexistierende Credentials, „zuletzt gespeichert gewinnt") — der Unterschied ist rein interner Natur.

### 3.3 Phasen

- **A1 — Provider-Adapter (`anthropic-subscription`).** ✅
  - `AnthropicAuthMode` + Token-Spalte im Store.
  - `createLLM`-Branch in `packages/ai-provider/src/runtime.ts`: bei gesetztem `anthropicSubscriptionToken` Bearer-Fetch-Wrapper, der `x-api-key` rausreißt und `Authorization: Bearer` + `anthropic-beta: oauth-2025-04-20` setzt.
  - `probeAnthropicSubscription` in `validate-key.ts`: probiert `GET /v1/models`, retried mit Beta-Header bei 401, akzeptiert ein „inconclusive 401" als nicht-blockierend.
  - `LlmProviderManager.setAnthropicSubscriptionToken / clearAnthropicSubscriptionToken / setAnthropicAuthMode`.
- **A2 — Settings-UI.** ✅
  - Neue Karte „Claude.ai Pro/Max-Abo" unterhalb der Api-Schlüssel-Liste.
  - Button öffnet die Anthropic-CLI-Doku im Systembrowser.
  - „Speichern" probt, fragt bei inconclusiv Soft-Confirm, speichert.
  - Provider-Dropdown akzeptiert Anthropic auch wenn nur der Subscription-Token vorhanden ist.
- **A3 — Chat-Agent-Tools.** ✅
  - `settings_set_anthropic_subscription_token` + `settings_clear_anthropic_subscription_token`.
  - System-Prompt im „Self-Service-Einstellungen"-Block ergänzt um die Anthropic-Abo-Variante (incl. Drittapp-Caveat).
- **A4 — Docs.** ✅
  - `ANTHROPIC_AUTH.md` (root) deckt Wofür, Token-Erzeugung, Drittapp-Risiko, Wechsel, Lebensdauer ab.
  - `services/desktop/README.md` ergänzt um Subscription-Bullet mit Verweis.
  - `CHANGELOG.md` v0.1.131-Eintrag.
- **A5 — Smoke-Test.** ✅
  - `scripts/test-anthropic-subscription.mjs` exerziert Round-Trip + Keychain-Isolation gegen einen `electron`-Stub im CJS-Require-Cache.
- **A6 — In-App-OAuth-Flow.** ✅ (v0.1.133)
  - `src/main/auth/anthropic-oauth.ts`: PKCE-Helfer (`generatePkce`,
    `buildAuthorizationUrl`, `exchangeCodeForToken`) gegen denselben
    öffentlichen `client_id` wie `claude setup-token`.
  - `src/main/auth/anthropic-oauth-flow.ts`: orchestriert ein
    Electron-`BrowserWindow` (Partition `persist:anthropic-oauth`,
    sandboxed renderer), fängt den Redirect auf
    `console.anthropic.com/oauth/code/callback` per
    `will-redirect`/`will-navigate` ab, prüft den State, tauscht den
    Code gegen ein Access-Token und cleant Window + Timer bei
    Abbruch/Timeout/Fehler.
  - IPC: `agent:connectAnthropicSubscription` ruft den Flow auf,
    persistiert über die bestehende Subscription-Token-Pipeline und
    flippt den Auth-Modus auf `"subscription"`.
  - UI: First-Run-Wizard-Karte 3 + Settings-Karte zeigen primär „Mit
    Claude.ai verbinden". Der Paste-Flow bleibt als
    Advanced-Disclosure darunter.
  - Smoke-Test: `scripts/test-anthropic-oauth.mjs` testet die reinen
    Helfer (Verifier-Länge, sha256-Round-Trip, URL-Parameter). Der
    Live-Round-Trip braucht ein echtes Anthropic-Konto und bleibt
    manuelles QA.

### 3.4 Bewusste Begrenzungen

- Producer-Subprocesse (company-publication etc.) laufen weiterhin env-getrieben über `@ava/ai-provider/getLLM`. Im Subscription-Modus reicht der Desktop-Manager kein Credential durch (`getProducerLlmEnv` returnt `null` für anthropic+subscription); der Producer fällt entweder auf seine env-baked LLM zurück oder verbleibt im wait-for-config-Zustand. Das ist akzeptabel, weil A1 ausdrücklich nur den in-process Chat-Agent ans Abokontingent koppelt — eine spätere Phase könnte den Token via Header mit-shippen, sobald die Producer-Architektur einen sicheren in-process Header-Slot anbietet.
- ~~Anthropics OAuth-via-Browser-Flow (PKCE in eigenem Fenster) bleibt bewusst aus. Anthropic dokumentiert ihn explizit nur für Claude Code; AVA bleibt beim user-pasted-token-Workflow.~~ → seit v0.1.133 (Phase A6) implementiert: AVA öffnet ein eigenes `BrowserWindow`, läuft denselben PKCE-Flow mit dem öffentlichen Claude-Code-`client_id` und fängt den Code per Redirect-Interception ab. Der Paste-Flow bleibt als Advanced-Fallback erhalten, weil ein In-App-Window in SSO-Setups gelegentlich nicht weiterkommt.

---

## 4. Deferred-processing quota (Q-track)

**Status:** Shipped in v0.1.137 (2026-05-11). M12 (per-row matrix
parked-pill) deferred to a follow-up task.

**Problem:** Pre-v0.1.137 the gateway's `assertQuotaAvailable` rejected
imports with a 402 the moment they would exceed the tenant's quota
(`used + neededCount > limit`). A free-tier user at 24/25 importing
10 companies got all 10 refused. Worse, the user couldn't even see the
match/preview UX for the 9 they weren't entitled to — the gate ran
before any work happened.

**Fix:** Imports now accept unconditionally. The quota gate moves down
to the per-company producer-trigger publish in master-data:

- Each company calls the gateway's new
  `POST /internal/quota/try-reserve` (HMAC-authed). The endpoint locks
  the `TenantBilling` row, recomputes `used + parkedCount + count`,
  and grants when it fits under `limit`.
- On grant: master-data fires the per-company upsert events through
  the new `publishCompanyProducerTriggers` helper, which lifts the
  inline publish-pair from the two call sites
  (`upload-companies-excel-command.ts` ~line 404 onwards, and
  `emit-german-company-upsert-events-command.ts` ~line 138 onwards).
- On deny: master-data calls `POST /internal/quota/park` to record a
  `ParkedCompany` row keyed by `(tenantId, germanCompanyId)`. The
  resume-worker replays parked rows.

**Park-state location:** Gateway DB (new `ParkedCompany` table). NOT
master-data. Reason: master-data's `GermanCompany` table is global
(HRB-sourced lookup, tenant-agnostic); adding a per-tenant flag there
would break the compute-locality invariant. The gateway already hosts
every other tenant-scoped table (`TenantBilling`, `UsageEntry`,
`EntityProgress`), so it's the natural home.

**Resume triggers:**
1. **Stripe webhook** — after `upsertSubscriptionState` flips the
   tier, `lib/billing.ts` fires `resumeParkedForTenant(tenantId)`.
2. **5-min cron** in `lib/quota-resume-worker.ts`. Two concerns:
   - Roll expired `periodEnd` forward for paid tiers so resumed rows
     fall under the new period.
   - Scan `ParkedCompany` for distinct tenantIds; fire the resume for
     each. Master-data's `try-reserve` per row decides what fits.

**Throttle:** in-memory `Set<string>` of in-flight tenants in the
gateway, plus 200ms inter-batch delay and a 50-iteration cap per
trigger. Batch size 20.

**Internal HMAC channel:**
- Header `X-Internal-Signature: hex(hmac-sha256(secret, body))`.
- Same `INTERNAL_HMAC_SECRET` on both apps (Fly secret).
- Gateway: `/internal/*` mounted in `index.ts` at app-level, HMAC
  middleware at `middleware/internal-auth.ts`.
- Master-data: HMAC middleware lives at
  `web/api/middlewares/request/internal-auth.ts`, mounted via the new
  `beforeAuth` hook in `onRequest` so it runs before the JWT chain.

**Renderer:**
- `UsageSnapshot` carries a new `parkedCount: number` field.
- `QuotaExhaustedBanner` has three variants now: exhausted+parked,
  exhausted+empty-park, headroom+parked.
- TransactionDetail per-row pill is M12, deferred.

**Tests:** Jest for the master-data helper (granted → publishes,
denied → park); a script-style smoke test in
`services/db-gateway/scripts/test-quota-resume.mjs`.

---

## 5. Agent-native charts (v0.1.141)

Detailed spec lives in [`PLANS_chart_skill.md`](./PLANS_chart_skill.md);
landed as Phases C1–C5 (Path-2 fence-extractor inside `renderChatContent`,
no `react-markdown` swap). Six pure-SVG chart kinds (`bar` / `hbar` /
`line` / `area` / `pie` / `scatter`), tight `yup` schema, theme-aware
palette, streaming-safe placeholder, `ChartErrorBoundary` for render-time
throws, text-table fallback for any invalid spec. Test harness:
`pnpm -F @ava/desktop test:chart`.

---

## Cross-cutting

Both workstreams above share one anchor: **the system prompt**. Adding tools (Section 1) and adding skills (Section 2) both extend it. To avoid prompt bloat:

- Tool descriptions stay ~1 line each; the bulky parameter docs live in the JSON schema the model gets separately.
- Skill descriptions stay ~2 lines; the full body only loads on explicit invocation OR when the agent's auto-match decision says yes.
- Auto-compaction strategy: keep the first 5000 tokens of each invoked skill in context (matches Anthropic's pattern); discard older skill bodies if a new one is invoked and the budget is exhausted.

This is a check we'll add to `services/desktop/src/main/agent/prompts.ts` once skills land — measure compiled-prompt tokens, warn at >12k, hard-fail at >20k.
