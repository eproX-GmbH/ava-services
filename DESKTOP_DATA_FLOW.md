# Desktop-App Data Flow & Gateway Scope

**Status:** v0.1 — 2026-04-24
**Purpose:** Source of truth for `services/db-gateway/src/routes/v1.ts`. Every endpoint the gateway exposes must trace back to a workflow here. Conversely, every workflow must land at a concrete endpoint (or be explicitly deferred).
**Companion docs:** [`INVENTORY.md`](./INVENTORY.md) (what exists), [`DECISIONS.md`](./DECISIONS.md) D3 + D11 (why thin, why online-only).

---

## 1. Purpose & non-goals

**Goal:** Define the minimum gateway surface the Electron Desktop-App needs to replace the current `user-interface/` Next.js app. The gateway is the *only* outbound path from desktop to cloud Postgres.

**Non-goals:**
- Mirroring the full per-service REST surface. UI is read-heavy; many service endpoints are internal-facing (service-to-service, event handlers) and do not need a desktop path.
- Building new product features. This spec captures what the UI does today + obvious gaps where the UI never exposed a backend feature that already exists (notably company-evaluation).
- Auth issuance. Per D3 the customer's auth service mints tokens; gateway only verifies.

**Constraints recap (D3/D11):**
- One fly.io app per customer (tenant isolation at infra level).
- JWT-only, 15min access + 7d refresh at the issuer.
- Synchronous request/response — no offline queue, no retry semantics in the gateway.
- Rate-limit in-memory, per tenant.
- Audit log on every authenticated request.

---

## 2. User workflows

Grouped by screen-equivalent. Each workflow lists the **reads** (R) and **writes** (W) it performs. Workflows map 1:1 to Desktop-App screens or actions.

### 2.1 Data ingest & pipeline

| # | Workflow | R/W | Description |
|---|---|---|---|
| W1 | Upload company Excel | W | User picks an .xlsx file; desktop POSTs it; pipeline kicks off (master-data publishes `germanCompany.upsert` → 5 downstream services extract) |
| W2 | List my transactions | R | Paginated list of the user's ingest/evaluation transactions |
| W3 | View transaction detail | R | Single transaction with per-entity state breakdown |
| W4 | Watch transaction progress | R (stream) | Live updates as services report `IN_PROGRESS → DONE/ERROR/INTERIM` |
| W5 | List processing errors | R | Errors per (transaction, company) |

### 2.2 Company discovery & drill-down

| # | Workflow | R/W | Description |
|---|---|---|---|
| W6 | Fuzzy-search German companies | R | Elasticsearch-backed typeahead (`master-data`) |
| W7 | Browse company list with filters | R | Paginated list with filter predicates |
| W8 | View company profile | R | Profile text + business purpose (`company-profile`) |
| W9 | View company keywords | R | Extracted keywords |
| W10 | View company website data | R | Domain + metadata + SERP (`website`) |
| W11 | View company publications | R | Annual financial disclosures (`company-publication`) |
| W12 | View company contacts | R | Persons + emails (`company-contact`) |
| W13 | View structured content | R | Legal form, directors, share capital (`structured-content`) |

### 2.3 Evaluation (currently backend-only — **gap** vs today's UI)

| # | Workflow | R/W | Description |
|---|---|---|---|
| W14 | Submit offer / RFQ analysis | W | Extract target skill profile from an offer; run best-match |
| W15 | View best-match result | R | Ranked companies for an offer |
| W16 | Give match feedback | W | Thumbs-up/down on individual matches |
| W17 | Start RAG chat session | W | Natural-language Q&A over a transaction's data |
| W18 | Send chat message | W | Continue a chat session |
| W19 | List chat sessions | R | History for a transaction |
| W20 | Run k-means clustering | W | Cluster company embeddings, render viz |
| W21 | Run comparison | W | Multi-company side-by-side; backed by embeddings |
| W22 | View clustering/comparison result | R | Fetch ready-state outputs |

### 2.4 Writes that the UI exposes today

| # | Workflow | R/W | Description |
|---|---|---|---|
| W23 | Correct a company profile | W | Manual override of extracted profile text |
| W24 | Correct a website URL | W | Manual override of detected domain |
| W25 | Correct a publication row | W | Manual edit of revenue / employees / etc. |

**Deliberately deferred / out of scope:**
- Login / token refresh — lives at the customer auth issuer, not the gateway (D3).
- User administration, tenant management — handled by the issuer / separate admin tool.
- Service-to-service endpoints (upsert events, `/api/germany/v1/events`, bulk-upsert) — these remain internal to the service mesh.

---

## 3. Entity graph (desktop-visible)

Simplified, reader-focused. Implicit FKs (cross-service references by `companyId` / `transactionId` without DB constraints — §4 of INVENTORY covers this).

```
Tenant ──< User ──< Transaction ──< EntityTransaction  (one row per (transaction, companyId, service))
                                   └─< ProcessingError

Company (companyId) ──┬── CompanyProfile (+ BusinessPurpose)
                      ├── CompanyKeyword[]
                      ├── Website (+ CompanySerp, JobPosting, DeepResearch)
                      ├── CompanyPublication[]  (one per disclosure year)
                      ├── StructuredContent (+ ManagingDirector[])
                      ├── CompanyContact[]
                      └── EvaluationData (embeddings — server-only)

BestMatchJob ──< MatchResult[] ──< MatchFeedback
ChatSession ──< ChatMessage[]
Cluster / Comparison — evaluation artifacts, keyed by transaction
```

**Identity:** `companyId` (string) is the universal key across services. No cross-service DB FKs; integrity is event-driven. **Desktop implication:** the gateway should accept `companyId` as a first-class path param and fan out reads per workflow rather than expect a pre-joined view.

---

## 4. Read endpoints — gateway surface

Shape convention: `/v1/<noun>[/<id>[/<sub-resource>]]`, always versioned, always JSON.

All endpoints require `Authorization: Bearer <token>` (verified per §6 of `services/db-gateway/README.md`). Scopes in parens — enforced via `requireScope()`.

### 4.1 Companies & drill-down (W6–W13)

| Method | Path | Scope | Maps to |
|---|---|---|---|
| `GET` | `/v1/companies/search?q=&limit=` | `company:read` | master-data fuzzy search (W6) |
| `GET` | `/v1/companies?page=&pageSize=&filter=…` | `company:read` | master-data list (W7) |
| `GET` | `/v1/companies/:companyId` | `company:read` | master-data detail |
| `GET` | `/v1/companies/:companyId/profile` | `company:read` | company-profile detail (W8) |
| `GET` | `/v1/companies/:companyId/keywords` | `company:read` | company-profile keywords (W9) |
| `GET` | `/v1/companies/:companyId/website` | `company:read` | website detail (W10) |
| `GET` | `/v1/companies/:companyId/publications` | `company:read` | company-publication list (W11) |
| `GET` | `/v1/companies/:companyId/contacts` | `company:read` | company-contact list (W12) |
| `GET` | `/v1/companies/:companyId/structured-content` | `company:read` | structured-content detail (W13) |

### 4.2 Transactions (W2–W5)

| Method | Path | Scope | Maps to |
|---|---|---|---|
| `GET` | `/v1/transactions?page=&pageSize=` | `transaction:read` | user's txns across services (W2) |
| `GET` | `/v1/transactions/:transactionId` | `transaction:read` | txn detail (W3) |
| `GET` | `/v1/transactions/:transactionId/entities?page=&pageSize=` | `transaction:read` | per-entity state (W3) |
| `GET` | `/v1/transactions/:transactionId/entities/:companyId` | `transaction:read` | one entity's state |
| `GET` | `/v1/transactions/:transactionId/errors` | `transaction:read` | processing errors (W5) |

### 4.3 Evaluation reads (W15, W19, W22)

| Method | Path | Scope | Maps to |
|---|---|---|---|
| `GET` | `/v1/evaluations/best-matches/:id` | `evaluation:read` | best-match result (W15) |
| `GET` | `/v1/evaluations/best-matches?transactionId=` | `evaluation:read` | list by transaction |
| `GET` | `/v1/evaluations/chats?transactionId=` | `evaluation:read` | chat sessions (W19) |
| `GET` | `/v1/evaluations/chats/:sessionId/messages?page=&pageSize=` | `evaluation:read` | chat history |
| `GET` | `/v1/evaluations/clusters/:id` | `evaluation:read` | cluster result (W22) |
| `GET` | `/v1/evaluations/comparisons/:id` | `evaluation:read` | comparison result (W22) |

---

## 5. Write endpoints — gateway surface

All writes are **synchronous to the gateway** but may be **asynchronous downstream** (service publishes an event, pipeline runs). The response reports the initial persistence, not pipeline completion — the Desktop-App follows up via the realtime channel (§6).

### 5.1 Ingest (W1)

| Method | Path | Scope | Notes |
|---|---|---|---|
| `POST` | `/v1/imports/excel` (multipart) | `import:write` | `master-data` `/api/v1/data-care` equivalent. Returns `{ transactionId }`. Pipeline runs via events. |

### 5.2 Evaluation writes (W14, W16, W17, W18, W20, W21)

| Method | Path | Scope | Notes |
|---|---|---|---|
| `POST` | `/v1/evaluations/best-matches` | `evaluation:write` | body: offer text / RFQ → returns `{ id }` (W14) |
| `POST` | `/v1/evaluations/offer-analysis` | `evaluation:write` | body: job posting → returns target-profile |
| `POST` | `/v1/evaluations/best-matches/:id/feedback` | `evaluation:write` | body: `{ companyId, signal }` (W16) |
| `POST` | `/v1/evaluations/chats` | `evaluation:write` | body: `{ transactionId, question }` → `{ sessionId, messageId }` (W17) |
| `POST` | `/v1/evaluations/chats/:sessionId/messages` | `evaluation:write` | body: `{ question }` (W18) |
| `POST` | `/v1/evaluations/clusters` | `evaluation:write` | body: `{ transactionId, k }` → `{ id }` (W20) |
| `POST` | `/v1/evaluations/comparisons` | `evaluation:write` | body: `{ companyIds[] }` → `{ id }` (W21) |

### 5.3 Manual corrections (W23–W25)

| Method | Path | Scope | Notes |
|---|---|---|---|
| `PUT` | `/v1/companies/:companyId/profile` | `company:write` | upsert (W23) |
| `PUT` | `/v1/companies/:companyId/website` | `company:write` | upsert (W24) |
| `PUT` | `/v1/companies/:companyId/publications/:year` | `company:write` | upsert single year row (W25) |

**Scope tags:** `company:read`, `company:write`, `transaction:read`, `evaluation:read`, `evaluation:write`, `import:write`. Six scopes total, kept minimal on purpose (D3 JWT format supports space-separated scopes).

---

## 6. Realtime channel (W4 — transaction progress)

Today each service exposes its own WebSocket for transaction state. The Desktop-App should not maintain 6 concurrent WebSockets.

**Decision (2026-04-25):** Path A — extend the event bus. Each service that owns an `EntityTransaction` row publishes a per-row `transaction.progress` CloudEvent when the row reaches a terminal state. The gateway subscribes once, fans out via SSE to each connected client.

Endpoint:

```
GET /v1/transactions/:transactionId/events  (text/event-stream)
Scope required: transaction:read
```

**Per-row events only — no aggregate counts.** Services depend on each other (master-data → website / structured-content → company-profile → company-publication / company-contact / company-evaluation). Companies legitimately drop out of the chain when an upstream service finds nothing for them, so no service can authoritatively compute "100% done". The Desktop-App reconstructs the per-company × per-service matrix client-side from the per-row stream.

**Wire format.** SSE events with the `event:` field set:
- `open` — `{ transactionId }` (initial frame)
- `progress` — `TransactionProgressPayload` (one per company × service, terminal-state only)
- `ping` — empty heartbeat every 25s

There is no terminal `end` frame: the gateway cannot synthesize one (same dependency-chain reason). The stream stays open until the client disconnects.

`TransactionProgressPayload` shape (locked in `@ava/event` 1.1.37):
```ts
{
  transactionId: string;
  tenantId: string;        // gateway tenant-gates on this
  service: string;         // "company-profile" | "company-publication" | ...
  companyId: string;       // the row this event is about
  state: "completed" | "failed" | "skipped";
  errorMessage?: string;
  updatedAt: string;       // ISO8601
}
```

SSE chosen over WebSocket because:
- One-way (server → client), which matches the actual use case
- Works over HTTP/2, auto-reconnects, plays well with fly.io proxies
- Easier to audit — each tick is just an HTTP request extension

**Producer responsibility.** All 6 services that own an `EntityTransaction` (company-profile, company-publication, company-contact, company-evaluation, website, structured-content) MUST publish one `transaction.progress` event per company-row when it reaches a terminal state, alongside their existing in-process WebSocket emits. The legacy per-service WebSockets remain available during transition; once the Desktop-App ships against SSE the WebSocket routes are slated for removal in Step 7.

**Tenant identification.** Producers source `tenantId` from `process.env.TENANT_ID`, set per fly.io customer deploy (D1 single-tenant model). The gateway tenant-gates on this against the caller's JWT `tenantId` claim — events for other tenants are silently dropped at the SSE writer.

---

## 7. Cross-cutting concerns

**Pagination.** Consistent shape: query params `page` (1-based) + `pageSize` (default 25, max 200). Response: `{ items: T[], page, pageSize, total }`.

**Errors.** RFC 7807-ish: `{ error: "<slug>", message: string, detail?: object }`. HTTP codes: 400 validation, 401 auth, 403 scope, 404 not found, 409 conflict, 429 rate-limit, 5xx server.

**Idempotency.** `POST /v1/imports/excel` and `POST /v1/evaluations/*` accept `Idempotency-Key` header (24h replay window). Safe to resend on network flake.

**Tracing.** `X-Request-Id` echoed to response + written to `AuditLog.requestId`. The Desktop-App generates one per user-visible action.

**Tenant isolation.** Gateway *must* filter every query by `c.get("auth").tenantId`. No endpoint takes a `tenantId` query param — it always comes from the verified JWT.

---

## 8. Coverage check

| Workflow | Endpoint(s) |
|---|---|
| W1 Upload Excel | `POST /v1/imports/excel` |
| W2 List transactions | `GET /v1/transactions` |
| W3 View transaction | `GET /v1/transactions/:id` + `/entities` |
| W4 Watch progress | `GET /v1/transactions/:id/events` (SSE) |
| W5 List errors | `GET /v1/transactions/:id/errors` |
| W6 Search | `GET /v1/companies/search` |
| W7 Browse | `GET /v1/companies` |
| W8 Profile | `GET /v1/companies/:id/profile` |
| W9 Keywords | `GET /v1/companies/:id/keywords` |
| W10 Website | `GET /v1/companies/:id/website` |
| W11 Publications | `GET /v1/companies/:id/publications` |
| W12 Contacts | `GET /v1/companies/:id/contacts` |
| W13 Structured content | `GET /v1/companies/:id/structured-content` |
| W14 Offer / best-match | `POST /v1/evaluations/best-matches` + `/offer-analysis` |
| W15 Best-match result | `GET /v1/evaluations/best-matches/:id` |
| W16 Match feedback | `POST /v1/evaluations/best-matches/:id/feedback` |
| W17 Start chat | `POST /v1/evaluations/chats` |
| W18 Send message | `POST /v1/evaluations/chats/:sid/messages` |
| W19 List chats | `GET /v1/evaluations/chats` |
| W20 K-means | `POST /v1/evaluations/clusters` |
| W21 Comparison | `POST /v1/evaluations/comparisons` |
| W22 View cluster/comparison | `GET /v1/evaluations/clusters/:id` + `/comparisons/:id` |
| W23 Correct profile | `PUT /v1/companies/:id/profile` |
| W24 Correct website | `PUT /v1/companies/:id/website` |
| W25 Correct publication | `PUT /v1/companies/:id/publications/:year` |

All 25 workflows covered.

**Endpoint count:** 32 endpoints across 6 scope tags. Target for Step 5 implementation: batch by section (4.1, 4.2, 4.3 reads first — these unblock the largest UI surface with zero write risk).

---

## 9. Resolved questions (2026-04-24)

1. **Tenant boundary on `companyId`** → **Global.** All tenants see all companies; `companyId` is not tenant-scoped. Company read endpoints (§4.1) filter only by `companyId`, NOT by tenant. Tenant scoping still applies to tenant-owned artifacts (transactions, chat sessions, best-match jobs, match feedback, clusters, comparisons, audit log).
2. **Audit-trail depth for corrections (W23–W25)** → **Deferred to Step 7 hardening.** v0 ships plain upserts; revision history is a separate schema + middleware change later.
3. **SSE vs polling for W4** → **SSE from the start, no polling fallback.** Read endpoints that depend on realtime progress (§4.2) are blocked until the SSE bridge in §6 is ready.

## 10. Open questions (still pending)

4. **Embedding API exposure.** Company-evaluation uses `text-embedding-3-large` via OpenAI. Desktop doesn't call this directly (server-internal). Confirm this stays true when the evaluation pipeline moves to desktop-local compute post-transition.
5. **File download / report export.** None of W1–W25 includes "download PDF report" today. If the Desktop-App adds this, we need `GET /v1/…/export` endpoints + pre-signed URL strategy.

---

## 11. Implementation order

Derived from the resolved questions above. Each bullet is a PR-sized batch.

1. **§4.1 Company reads (9 endpoints).** ✅ done. `companyId` is global, no cross-service tenant join needed. Hits master-data + 5 drill-down services.
2. **§6 SSE bridge (1 endpoint).** ✅ done. Transaction progress stream. Unblocks §4.2.
3. **§4.2 Transaction reads (5 endpoints).** ✅ done. Depends on 2. Gateway-side ownership check (§4.2 caches the user-transactions lookup per request).
4. **§4.3 Evaluation reads (6 endpoints).** ✅ done — five proxy cleanly to company-evaluation; **`GET /v1/evaluations/clusters/:id` returns 501** because upstream only exposes the `POST /api/v1/clusters/cluster/k-means` command. Removing the 501 = adding a cluster-query endpoint upstream (open follow-up). Two endpoints (chat messages by sessionId, comparisons by id) currently rely on JWT scope+tenant only — the underlying entities have no `transactionId` or `userId` column upstream, so cheap gateway-side ownership isn't possible until upstream adds one.
5. **§5.1 Excel import (1 endpoint).** ✅ done. Multipart in at the gateway, raw octet-stream out to `master-data` `POST /api/v1/data-care`. Upstream now sets a `Transaction-Id` response header (additive — the legacy xlsx response is unchanged); the gateway reads it and returns `202 { transactionId }` so the desktop client opens its SSE stream immediately. Idempotency-Key replay window is a Step 7 follow-up — not yet wired (see Open follow-ups below).
6. **§5.2 Evaluation writes (7 endpoints).** ✅ done. All seven proxy to `company-evaluation`. Bodies aligned to upstream contracts; the §5.2 table above was aspirational and several fields were missing/misnamed (see "Open §5.2 follow-ups" below). `chats` verifies transaction ownership via the shared `v1TxCache`; the rest gate on JWT scope+tenant only (companies are global per D2; chat sessions / comparisons have no upstream ownership column — same v0 trade-off as §4.3 reads).
7. **§5.3 Corrections (3 endpoints).** ✅ done. Three "re-scrape" PUT routes that fan out to company-profile / website / company-publication. Each one mirrors the same upstream command master-data fires through the CloudEvent pipeline — these gateway routes just expose the *manual* trigger path the desktop UI needs. Step 5 endpoint surface is now complete.

**Open §4.3 follow-ups (upstream company-evaluation work):**
- Add `GET /api/v1/clusters/:id` (clears the gateway 501).
- Add ownership signal (`userId` column or transaction link) on `chat-session`, `chat-message`, and `comparison-job` tables so the gateway can verify per-id reads without iterating the user's transaction list.

**Open §5.2 follow-ups (spec ↔ implementation drift to reconcile in §5.2 table):**
- `feedback`: spec said `{ companyId, signal }`; implementation accepts `{ bestMatchJobResultId, label, reason? }` (matches upstream — `label` is an enum: ACCEPTED/REJECTED/NOTSURE/IGNORED/CONTACTED/CLICKED). The spec wording was wrong; update §5.2 row to reflect reality.
- `chats` create: spec missed `topK` (required upstream); implementation defaults to 10.
- `chats/:sessionId/messages`: spec field `question` is renamed to `message` on the wire to upstream. Gateway accepts both `question` (the desktop name) and translates.
- `clusters`: spec was `{ transactionId, k }`; implementation is `{ companyIds[], k, topics[] }` because upstream's k-means controller takes companyIds explicitly. Caller resolves companyIds via §4.2 if it has only a transactionId. A future upstream `transactionId`-aware variant would let us collapse this back to the spec.
- `comparisons`: spec missed `targetCompanyId` (required upstream).
- Idempotency-Key wiring (advertised in §10) is not yet honored on §5.2 writes either. Folded into the §5.1 follow-up below.

**Open §5.3 follow-ups (spec ↔ implementation drift to reconcile in §5.3 table):**
- `profile`: spec wording implies field-level upsert; implementation re-scrapes a URL — body is `{ url }` because that's what `company-profile`'s `POST /api/v1/company-profiles` accepts. If the desktop UI later needs in-place field edits, that's an upstream addition (a new `PATCH` command on company-profile).
- `website`: implementation body is `{ companyName, street, zipCode, city }` (forwarded as the upstream re-scrape command). No field-level edit upstream.
- `publications`: spec was `/publications/:year` (per-year row upsert); upstream `company-publication`'s `PUT /api/v1/company-publications` takes `{ companyId, companyName, companyLocation }` and re-scrapes ALL years for the company. Path simplified to `/companies/:companyId/publications` (no `:year`). Per-year manual edit needs an upstream addition.

**Open §5.1 follow-ups:**
- Wire `Idempotency-Key` (gateway-side dedupe table, 24h window) for `POST /v1/imports/excel`. The advertised contract in §10 says we accept it; today we don't honor it. Low-stakes for v0 because upstream creates a fresh `transactionId` per call, but desktop-side network flakes can otherwise produce duplicate transactions.
