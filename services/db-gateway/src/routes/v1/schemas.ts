import { z } from "@hono/zod-openapi";

// Shared shapes for /v1.
//
// These describe the upstream DTOs the gateway proxies. Where upstream
// services apply explicit DTO mapping (the common case) we model the fields
// here so OpenAPI consumers get a tight contract. Where upstream itself
// stores opaque JSON blobs (CompanyContact's companyFacts etc.) we keep a
// `.passthrough()` object — tightening would mean shaping upstream first.
//
// Field nullability follows what upstream actually returns: optional with
// `.nullable()` where the column is nullable in the source service's
// schema, optional-only where it's a "may not appear" rather than "may be
// null" semantic difference. ISO timestamps stay `z.string()` (not
// `.datetime()`) since not every upstream guarantees a strict ISO format
// — we don't want to reject valid responses on a format technicality.

// ---- Path / query params ---------------------------------------------------

export const CompanyIdParam = z.object({
  companyId: z.string().min(1).openapi({ param: { name: "companyId", in: "path" } }),
});

export const PaginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});

export const SearchQuery = z.object({
  q: z.string().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

// ---- Companies (master-data) -----------------------------------------------

export const CompanyShape = z
  .object({
    companyId: z.string(),
    name: z.string(),
    location: z.string().nullable().optional(),
    registerNumber: z.string().nullable().optional(),
    registerType: z.string().nullable().optional(),
    state: z.string().nullable().optional(),
    districtCourt: z.string().nullable().optional(),
    createdAt: z.string(),
  })
  .openapi("Company");

// ---- Company profile (company-profile) -------------------------------------

export const CompanyProfileShape = z
  .object({
    id: z.string(),
    profile: z.string(),
    url: z.string().nullable().optional(),
    businessPurpose: z.string().nullable().optional(),
    keywords: z.array(z.string()).default([]),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("CompanyProfile");

// ---- Company keywords (company-profile) ------------------------------------

export const CompanyKeywordShape = z
  .object({
    companyId: z.string(),
    keyword: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("CompanyKeyword");

// ---- Website (website) -----------------------------------------------------
//
// Composite payload — the upstream mapper aggregates four sub-records into
// one response object. Sub-records are individually loose (the website
// service stores some fields as nullable strings) so most are optional.

const WebsiteCoreShape = z
  .object({
    companyId: z.string().optional(),
    siteName: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    tags: z.array(z.string()).default([]),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
  })
  .openapi("WebsiteCore");

const CompanySerpShape = z
  .object({
    companyId: z.string().optional(),
    url: z.string().nullable().optional(),
    companyNickname: z.string().nullable().optional(),
    category: z.string().nullable().optional(),
    latitude: z.number().nullable().optional(),
    longitude: z.number().nullable().optional(),
    address: z.string().nullable().optional(),
    phone: z.string().nullable().optional(),
    rating: z.number().nullable().optional(),
    reviewCount: z.number().nullable().optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
  })
  .openapi("CompanySerp");

// Deep-research and job-posting items aren't strictly modeled upstream
// (their schemas evolve with the LLM extractor) — keep them passthrough.
const DeepResearchShape = z.object({}).passthrough().openapi("DeepResearch");
const JobPostingShape = z.object({}).passthrough().openapi("JobPosting");

export const WebsiteShape = z
  .object({
    website: WebsiteCoreShape.optional(),
    companySerp: CompanySerpShape.optional(),
    deepResearches: z.array(DeepResearchShape).default([]),
    jobPostings: z.array(JobPostingShape).default([]),
  })
  .openapi("Website");

// ---- Structured content (structured-content) -------------------------------

const ManagingDirectorShape = z
  .object({
    firstName: z.string(),
    lastName: z.string(),
    birthDay: z.string().nullable().optional(),
    city: z.string().nullable().optional(),
  })
  .openapi("ManagingDirector");

export const StructuredContentShape = z
  .object({
    companyId: z.string(),
    name: z.string().nullable().optional(),
    corporatePurpose: z.string().nullable().optional(),
    shareCapital: z.string().nullable().optional(),
    legalForm: z.string().nullable().optional(),
    street: z.string().nullable().optional(),
    houseNumber: z.string().nullable().optional(),
    zipCode: z.string().nullable().optional(),
    city: z.string().nullable().optional(),
    foundingYear: z.string().nullable().optional(),
    managingDirectors: z.array(ManagingDirectorShape).default([]),
    lastRegisterEntry: z.string().nullable().optional(),
    lastRegisterModification: z.string().nullable().optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("StructuredContent");

// ---- Company publications (company-publication) ----------------------------

// Upstream stores the volume fields as `{value, currency}` value objects and
// `stateOfAffairs` as an aggregate `{topic, bullets, guidance, ...}` — keep
// them passthrough so the gateway's OpenAPI surface doesn't lie about the
// shape (and the renderer can read the nested data).
const VolumeShape = z
  .object({ value: z.number().nullable().optional(), currency: z.string().nullable().optional() })
  .passthrough();
const StateOfAffairsShape = z
  .object({
    topic: z.string().nullable().optional(),
    isRelevant: z.boolean().nullable().optional(),
    bullets: z.array(z.string()).default([]),
    guidance: z.array(z.string()).default([]),
    risksOpportunities: z.array(z.string()).default([]),
    kpis: z
      .array(
        z
          .object({
            name: z.string(),
            value: z.string(),
            period: z.string().nullable().optional(),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();

export const CompanyPublicationShape = z
  .object({
    companyId: z.string(),
    name: z.string().nullable().optional(),
    year: z.number().int().nullable().optional(),
    begin: z.string().nullable().optional(),
    end: z.string().nullable().optional(),
    salesVolume: VolumeShape.nullable().optional(),
    revenueVolume: VolumeShape.nullable().optional(),
    totalAssetsVolume: VolumeShape.nullable().optional(),
    stateOfAffairs: StateOfAffairsShape.nullable().optional(),
    employeeCount: z.number().int().nullable().optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("CompanyPublication");

// ---- Company contacts (company-contact) ------------------------------------
//
// `companyFacts`, `companyObservations`, `companySignals`, and `employments`
// are stored as JSON blobs upstream — keep them loose. Tightening these
// belongs at company-contact, not at the gateway.

export const CompanyContactShape = z
  .object({
    id: z.string(),
    companyName: z.string().nullable().optional(),
    websiteUrl: z.string().nullable().optional(),
    // Upstream returns these as arrays of fact-shaped objects (Fact[],
    // Observation[], Signal[]) — keep loose since the inner shape is
    // LLM-extractor dependent, but the array-vs-record distinction matters
    // for the renderer.
    companyFacts: z.array(z.record(z.string(), z.unknown())).default([]),
    companyObservations: z.array(z.record(z.string(), z.unknown())).default([]),
    companySignals: z.array(z.record(z.string(), z.unknown())).default([]),
    employments: z.array(z.record(z.string(), z.unknown())).default([]),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("CompanyContact");

// ---- Wrappers --------------------------------------------------------------

export const PaginatedShape = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    items: z.array(item),
    page: z.number().int(),
    pageSize: z.number().int(),
    total: z.number().int(),
  });

export const SearchResultShape = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    items: z.array(item),
    total: z.number().int().optional(),
  });

export const ErrorShape = z
  .object({
    error: z.string(),
    message: z.string().optional(),
    detail: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi("Error");

// ---- Transactions (company-profile) ----------------------------------------

export const TransactionIdParam = z.object({
  transactionId: z.string().min(1).openapi({ param: { name: "transactionId", in: "path" } }),
});

export const TransactionEntityParams = z.object({
  transactionId: z.string().min(1).openapi({ param: { name: "transactionId", in: "path" } }),
  companyId: z.string().min(1).openapi({ param: { name: "companyId", in: "path" } }),
});

export const TransactionShape = z
  .object({
    id: z.string(),
    /** User-supplied label set during ingest (`POST /v1/transactions`).
     *  Upstream stores it as nullable; not all rows carry one. Surfaced
     *  in the renderer's list + detail header — the id is opaque, the
     *  name is what the analyst actually recognises. */
    name: z.string().nullable().optional(),
    startTime: z.string().nullable().optional(),
    companyCount: z.number().int().nullable().optional(),
    // `userId` is the ownership field (gateway-side ownership check). Upstream
    // surfaces it on the detail route; not always present on list rows.
    userId: z.string().optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("Transaction");

export const EntityTransactionShape = z
  .object({
    id: z.string(),
    transactionId: z.string(),
    companyId: z.string(),
    state: z.enum(["completed", "failed", "skipped", "pending", "in_progress"]),
    finishedAt: z.string().nullable().optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("EntityTransaction");

// Gateway stamps `companyId` and `service` onto each upstream row in the
// errors fan-out (transactions.ts) so the Desktop-App can group without a
// re-lookup AND knows which pipeline stage produced the failure. `service`
// is one of the LLM-producer upstream identifiers (`structuredContent`,
// `companyProfile`, …); `masterData` never appears here because that stage
// has no per-row errors table.
export const ProcessingErrorShape = z
  .object({
    id: z.string(),
    companyId: z.string(),
    transactionId: z.string(),
    errorReason: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    service: z.string().optional(),
  })
  .openapi("ProcessingError");

// ---- Evaluations (company-evaluation) --------------------------------------
//
// §4.3 reads. All shapes are upstream DTOs; signal blobs / citations are
// passthrough because their structure is LLM-output dependent and evolves
// faster than the gateway should chase.

export const BestMatchIdParam = z.object({
  bestMatchId: z.string().min(1).openapi({ param: { name: "bestMatchId", in: "path" } }),
});

export const ComparisonIdParam = z.object({
  comparisonId: z.string().min(1).openapi({ param: { name: "comparisonId", in: "path" } }),
});

export const ChatSessionIdParam = z.object({
  sessionId: z.string().min(1).openapi({ param: { name: "sessionId", in: "path" } }),
});

export const ClusterIdParam = z.object({
  clusterId: z.string().min(1).openapi({ param: { name: "clusterId", in: "path" } }),
});

export const TransactionIdQuery = z.object({
  transactionId: z.string().min(1),
});

const BestMatchResultItemShape = z
  .object({
    id: z.string(),
    companyId: z.string().nullable().optional(),
    explanation: z.string().nullable().optional(),
    score: z.number().nullable().optional(),
    // Signals + match-feedback are LLM-shaped JSON blobs; keep loose.
    signals: z.record(z.string(), z.unknown()).nullable().optional(),
    matchFeedback: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .openapi("BestMatchResultItem");

export const BestMatchShape = z
  .object({
    id: z.string(),
    input: z.string(),
    transactionId: z.string().nullable().optional(),
    results: z.array(BestMatchResultItemShape).default([]),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("BestMatch");

export const ChatSessionShape = z
  .object({
    id: z.string(),
    transactionId: z.string(),
    allowedCompanyIds: z.array(z.string()).default([]),
    summary: z.string().nullable().optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("ChatSession");

export const ChatMessageShape = z
  .object({
    id: z.string(),
    sessionId: z.string(),
    role: z.enum(["user", "assistant"]),
    content: z.string(),
    // Citations: list of {companyId, sourceFieldRef, ...} blobs from the
    // RAG layer — keep passthrough until upstream locks the schema.
    citations: z.array(z.record(z.string(), z.unknown())).nullable().optional(),
    turnIndex: z.number().int(),
    createdAt: z.string(),
  })
  .openapi("ChatMessage");

const ComparisonRankingItemShape = z
  .object({
    id: z.string().optional(),
    companyId: z.string(),
    order: z.number().int(),
    createdAt: z.string().optional(),
  })
  .openapi("ComparisonRankingItem");

// ---- Evaluation writes (company-evaluation) --------------------------------
//
// §5.2 writes. Spec in DESKTOP_DATA_FLOW.md §5.2 was written aspirational
// — these schemas align to the actual upstream contracts (controller bodies
// in company-evaluation/src/web/api/controllers/v1/*). Drift documented in
// §11.

// Topics list reused by best-match + cluster (k-means uses the same set).
export const EvaluationTopic = z.enum([
  "keywords",
  "companyProfile",
  "businessPurpose",
  "serpCategory",
  "sales",
  "profits",
  "employees",
  "totalAssets",
  "stateOfAffairs",
]);

export const BestMatchCreateBody = z
  .object({
    companyIds: z.array(z.string().min(1)).min(2),
    input: z.string().min(1),
    transactionId: z.string().min(1).optional(),
    topics: z.array(EvaluationTopic).min(1),
  })
  .openapi("BestMatchCreate");

export const BestMatchCreateResponse = z
  .object({ bestMatchJobId: z.string() })
  .openapi("BestMatchCreateResponse");

export const OfferAnalysisBody = z
  .object({
    offer: z.string().min(1),
    topK: z.number().int().min(1).max(100).optional(),
  })
  .openapi("OfferAnalysis");

export const BestMatchFeedbackBody = z
  .object({
    bestMatchJobResultId: z.string().min(1),
    label: z.enum(["ACCEPTED", "REJECTED", "NOTSURE", "IGNORED", "CONTACTED", "CLICKED"]),
    reason: z.string().optional(),
  })
  .openapi("BestMatchFeedback");

export const ChatCreateBody = z
  .object({
    transactionId: z.string().min(1),
    question: z.string().min(1),
    topK: z.number().int().min(2).max(200).default(10),
  })
  .openapi("ChatCreate");

export const ChatCreateResponse = z
  .object({
    sessionId: z.string(),
    messageId: z.string().optional(),
  })
  .passthrough()
  .openapi("ChatCreateResponse");

export const ChatMessageCreateBody = z
  .object({
    // The desktop spec calls this `question`; upstream calls it `message`.
    // We accept the desktop name and re-key on the way out.
    question: z.string().min(1),
    scopeCompanyIds: z.array(z.string().min(1)).optional(),
    topK: z.number().int().min(2).max(200).optional(),
  })
  .openapi("ChatMessageCreate");

// Upstream chat-message POST returns OpenAI result + metadata; the exact
// shape is RAG-pipeline dependent. Keep loose.
export const ChatMessageCreateResponse = z
  .object({})
  .passthrough()
  .openapi("ChatMessageCreateResponse");

export const ClusterCreateBody = z
  .object({
    companyIds: z.array(z.string().min(1)).min(2),
    k: z.number().int().min(2).max(50),
    topics: z.array(EvaluationTopic).min(1),
  })
  .openapi("ClusterCreate");

export const ClusterCreateResponse = z
  .object({})
  .passthrough()
  .openapi("ClusterCreateResponse");

export const ComparisonCreateBody = z
  .object({
    companyIds: z.array(z.string().min(1)).min(2),
    targetCompanyId: z.string().min(1),
  })
  .openapi("ComparisonCreate");

export const ComparisonCreateResponse = z
  .object({ comparisonJobId: z.string() })
  .openapi("ComparisonCreateResponse");

// ---- Manual corrections (§5.3) ---------------------------------------------
//
// Three PUT-shaped upserts. Bodies match the upstream commands; the
// `companyId` is taken from the path and injected on the way out so the
// gateway URL keeps the natural REST shape (`/companies/:id/...`) even
// though upstream services accept companyId in the body.

export const CompanyProfileUpsertBody = z
  .object({
    // Upstream calls its endpoint POST /api/v1/company-profiles and treats it
    // as "scrape this URL for this company". Body upstream is {companyId,url};
    // we expose just `url` here and inject companyId from the path.
    url: z.string().min(1),
    // Upstream also accepts ?isSkippable=…; surfaced for the desktop client
    // that wants to retry-without-replace.
    isSkippable: z.boolean().optional(),
  })
  .openapi("CompanyProfileUpsert");

export const CompanyWebsiteUpsertBody = z
  .object({
    companyName: z.string().min(1),
    street: z.string().min(1),
    zipCode: z.string().min(1),
    city: z.string().min(1),
    isSkippable: z.boolean().optional(),
  })
  .openapi("CompanyWebsiteUpsert");

export const CompanyPublicationsUpsertBody = z
  .object({
    companyName: z.string().min(1),
    companyLocation: z.string().min(1),
  })
  .openapi("CompanyPublicationsUpsert");


//
// §5.1: the gateway accepts the multipart upload, hands the binary to
// master-data's `POST /api/v1/data-care`, and returns just the transactionId
// so the desktop client can subscribe to the SSE progress stream.

export const ImportExcelQuery = z.object({
  // Heading rows in the uploaded sheet that mark the company-name column(s).
  // Repeats are allowed; upstream parses them as a list.
  companyNameIdentifiers: z
    .union([z.string(), z.array(z.string())])
    .transform((v) => (Array.isArray(v) ? v : [v]))
    .openapi({ example: ["company"] }),
  // City column heading(s). Same multi-value shape as companyNameIdentifiers
  // — multiple columns get joined with a single space (e.g. postal-code +
  // city) so master-data sees a single location string per row.
  city: z
    .union([z.string(), z.array(z.string())])
    .transform((v) => (Array.isArray(v) ? v : [v])),
  // Optional transaction name (shown in the desktop UI's transaction list).
  name: z.string().optional(),
  // Whether to fall back to a fuzzy match for unmatched companies.
  isFuzzy: z.coerce.boolean().optional().default(false),
  // v0.1.57 — dry-run preview for the desktop chat agent. Returns
  // ImportPreview JSON instead of starting a transaction.
  dryRun: z.coerce.boolean().optional().default(false),
  // M2 — desktop counts the xlsx rows client-side and passes them so
  // the pre-import quota gate is exact. Optional: when omitted the
  // gate uses 1 (best-effort — a 0-row import won't push past quota
  // anyway). Master-data, not the gateway, is the source of truth
  // for the actual row count post-parse.
  expectedCount: z.coerce.number().int().nonnegative().optional(),
});

export const ImportExcelResponseShape = z
  .object({
    transactionId: z.string(),
  })
  .openapi("ImportExcelResponse");

// ---- Single-row company ingest (Phase 8.h) ---------------------------------
//
// JSON-shaped sibling of `/v1/imports/excel` — the agent (and any future
// "add a company" UI affordance) needs a way to push one company without
// asking the user to manufacture an xlsx. The gateway hand-encodes a
// minimal one-row workbook and forwards it to master-data through the
// same upstream path the bulk import uses, so the downstream pipeline
// (transaction row + 6 CloudEvents) is identical for one-row vs. N-row
// inputs.
//
// `name` and `city` are the canonical xlsx columns; `transactionName`
// becomes the optional `name` query param the bulk endpoint accepts.

export const CompanyIngestBody = z
  .object({
    /** Company name as it should appear in the xlsx `company` column. */
    name: z.string().min(1).max(500),
    /** City / location string for the upstream's location-resolution step. */
    city: z.string().min(1).max(200),
    /** Optional human label for the resulting transaction (visible in the
     *  Transactions list). Falls back to `Single ingest: <name>`. */
    transactionName: z.string().min(1).max(200).optional(),
    /** Whether master-data may fall back to a fuzzy match if the exact
     *  name+city tuple yields no match. Defaults to false to mirror the
     *  bulk default. */
    isFuzzy: z.boolean().optional().default(false),
    /** v0.1.57 — dry-run preview. Returns ImportPreview JSON instead of
     *  starting a transaction. */
    dryRun: z.boolean().optional().default(false),
  })
  .openapi("CompanyIngest");

export const CompanyIngestResponseShape = z
  .object({
    transactionId: z.string(),
  })
  .openapi("CompanyIngestResponse");

// ---- Multi-row JSON ingest (v0.1.57 — CRM Phase 2) -------------------------
//
// JSON-shaped bulk sibling of `/v1/imports/excel`. The CRM-import path needs
// to start a single transaction with N companies fetched from the user's
// connected CRM (HubSpot today, Salesforce + Dynamics later) without making
// the agent manufacture an xlsx. The gateway encodes the list into a multi-
// row workbook and forwards it to master-data through the same upstream
// `/api/v1/data-care` endpoint the file upload uses.
//
// Same downstream behavior: ONE transaction row + 6 CloudEvents fan out to
// all producers. Per-company progress shows up on the same matrix as a
// file-uploaded transaction.

export const FromListIngestBody = z
  .object({
    /** Companies to ingest. Order is preserved into the synthetic xlsx. */
    companies: z
      .array(
        z.object({
          name: z.string().min(1).max(500),
          city: z.string().min(1).max(200),
        }),
      )
      .min(1)
      .max(5000),
    /** Optional human label for the resulting transaction. Defaults to
     *  `<provider> import: N companies` — but the caller usually knows
     *  the source better than the gateway does. */
    transactionName: z.string().min(1).max(200).optional(),
    /** Mirrors the bulk endpoint's fuzzy-match fallback. */
    isFuzzy: z.boolean().optional().default(false),
    /** v0.1.57 — dry-run preview. Returns ImportPreview JSON instead of
     *  starting a transaction. */
    dryRun: z.boolean().optional().default(false),
  })
  .openapi("FromListIngest");

export const FromListIngestResponseShape = z
  .object({
    transactionId: z.string(),
    companyCount: z.number().int().nonnegative(),
  })
  .openapi("FromListIngestResponse");

// ---- Dry-run import preview (v0.1.57 — CRM Phase 2 part 2) ----------------
//
// When the desktop chat agent is about to import a list of companies, it
// first runs the request with `dryRun: true`. Master-data executes the full
// match + ES fuzzy search but skips transaction creation + event publish,
// returning this envelope. The agent walks the user through the unmatched
// rows + low-confidence candidates, then re-issues the request with
// `dryRun: false` and the corrected company list.

export const ImportPreviewShape = z
  .object({
    dryRun: z.literal(true),
    providedCount: z.number().int().nonnegative(),
    matched: z.array(
      z.object({
        name: z.string(),
        location: z.string(),
        companyId: z.string(),
        matchingType: z.enum(["direct", "history"]),
      }),
    ),
    unmatched: z.array(
      z.object({
        name: z.string(),
        location: z.string(),
        candidates: z.array(
          z.object({
            companyId: z.string(),
            name: z.string(),
            location: z.string(),
            /** Elasticsearch _score. Higher = better match.
             *  Raw — the agent normalizes for UI display. */
            score: z.number(),
          }),
        ),
      }),
    ),
  })
  .openapi("ImportPreview");

// ---- Pipeline view (cross-producer fan-out) --------------------------------
//
// Per-company × per-producer state matrix for the desktop W3 transaction view.
// One row per company; one cell per pipeline stage. Built by fanning out to
// every producer's `/api/v1/transactions/:tid/entities` and merging by
// companyId — the gateway is the only place that has cross-service visibility.
//
// State semantics:
//   - "completed" / "failed" / "skipped" / "in_progress" — from upstream
//     EntityTransaction.state (matches EntityTransactionShape)
//   - "pending" — synthesized when the company appears in some other stage
//     but the queried producer hasn't (yet) created its row
//   - master-data: synthesized as "completed" iff the company appears in any
//     downstream stage (master-data has no per-row table; the existence of
//     downstream rows proves master-data fanned out successfully)
//
// `errorCount` is best-effort: a value of 1 is set when the cell's state is
// "failed" (we know there's at least one error; the drill-down panel pulls
// the full list via /v1/transactions/:tid/errors). Zero otherwise.

export const PipelineStage = z.enum([
  "masterData",
  "structuredContent",
  "companyPublication",
  "website",
  "companyProfile",
  "companyContact",
  "companyEvaluation",
]);

export const PipelineCellState = z.enum([
  "completed",
  "failed",
  "skipped",
  "pending",
  "in_progress",
]);

export const PipelineCellShape = z
  .object({
    state: PipelineCellState,
    updatedAt: z.string().nullable().optional(),
    errorCount: z.number().int().nonnegative().default(0),
  })
  .openapi("PipelineCell");

export const PipelineRowShape = z
  .object({
    companyId: z.string(),
    cells: z.object({
      masterData: PipelineCellShape,
      structuredContent: PipelineCellShape,
      companyPublication: PipelineCellShape,
      website: PipelineCellShape,
      companyProfile: PipelineCellShape,
      companyContact: PipelineCellShape,
      companyEvaluation: PipelineCellShape,
    }),
    lastActivityAt: z.string().nullable().optional(),
  })
  .openapi("PipelineRow");

export const PipelineShape = z
  .object({
    transactionId: z.string(),
    totalCompanies: z.number().int().nonnegative(),
    // Canonical stage order — clients render columns in this sequence.
    stages: z.array(PipelineStage),
    // Stages whose upstream call failed at fetch time. Cells for these
    // stages are filled with state="pending" and `errorCount: 0` (we can't
    // tell). Renderer should gray-out these columns and surface a banner.
    unavailableStages: z.array(PipelineStage).default([]),
    rows: z.array(PipelineRowShape),
  })
  .openapi("Pipeline");

// ---- Per-stage retry (DESKTOP_DATA_FLOW.md §6.2) ---------------------------
//
// `POST /v1/transactions/:tid/entities/:cid/retry` republishes the trigger
// AMQP event(s) for a single (transaction, company, stage). The gateway maps
// the requested `stage` to the producer service that owns the relevant
// `*.upsert*` event:
//
//   - structuredContent  → master-data
//   - companyPublication → master-data
//   - website            → structured-content
//   - companyProfile     → website + structured-content
//   - companyContact     → website
//   - companyEvaluation  → fan-out across structured-content, company-
//                          publication, website, company-profile, company-
//                          contact (each republishes the slice it owns)
//
// `companyName` is only needed when retrying `companyContact` (the
// website.upsertCompanyContact event requires it).

export const RetryStage = z.enum([
  "structuredContent",
  "companyPublication",
  "website",
  "companyProfile",
  "companyContact",
  "companyEvaluation",
]);

export const RetryStageBody = z
  .object({
    stage: RetryStage,
    companyName: z.string().optional(),
  })
  .openapi("RetryStageBody");

export const RetryStageDispatch = z
  .object({
    upstream: z.string(),
    stage: z.string(),
    ok: z.boolean(),
    status: z.number().int().optional(),
    body: z.unknown().optional(),
    error: z.string().optional(),
  })
  .openapi("RetryStageDispatch");

export const RetryStageResultShape = z
  .object({
    transactionId: z.string(),
    companyId: z.string(),
    stage: RetryStage,
    dispatched: z.array(RetryStageDispatch),
    ok: z.boolean(),
  })
  .openapi("RetryStageResult");

export const ComparisonShape = z
  .object({
    id: z.string(),
    targetCompanyId: z.string().nullable().optional(),
    companyIds: z.array(z.string()).default([]),
    ranking: z.array(ComparisonRankingItemShape).default([]),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("Comparison");
