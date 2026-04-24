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

**Proposal:** Gateway exposes **one SSE endpoint per transaction**:

```
GET /v1/transactions/:transactionId/events  (text/event-stream)
```

Server-side, the gateway bridges all per-service WebSocket feeds into a single stream, tagging each event with `{ service, state, companyId?, timestamp }`. SSE chosen over WebSocket because:
- One-way (server → client), which matches the actual use case
- Works over HTTP/2, auto-reconnects, plays well with fly.io proxies
- Easier to audit — each tick is just an HTTP request extension

**Deferred until Step 6:** The bridging implementation needs service-side subscription; for the v0 gateway we can ship a polling endpoint (`GET /v1/transactions/:id/entities` called every N seconds) and upgrade to SSE once the supervisor is wired.

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

1. **§4.1 Company reads (9 endpoints).** Unblocked — `companyId` is global, no cross-service tenant join needed. Hits master-data + 5 drill-down services. Zero write risk, largest UI surface unblocked.
2. **§6 SSE bridge (1 endpoint).** Transaction progress stream. Unblocks §4.2.
3. **§4.2 Transaction reads (5 endpoints).** Depends on 2.
4. **§4.3 Evaluation reads (6 endpoints).** Independent — can land in parallel with 2 or 3.
5. **§5.1 Excel import (1 endpoint).** First write path; validates the idempotency-key + event-fanout pattern.
6. **§5.2 Evaluation writes (7 endpoints).** Exposes the back-of-the-house evaluation features for the first time.
7. **§5.3 Corrections (3 endpoints).** Simple upserts; revision history deferred per Q2.
