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

export const CompanyPublicationShape = z
  .object({
    companyId: z.string(),
    name: z.string().nullable().optional(),
    year: z.number().int().nullable().optional(),
    begin: z.string().nullable().optional(),
    end: z.string().nullable().optional(),
    salesVolume: z.number().nullable().optional(),
    revenueVolume: z.number().nullable().optional(),
    totalAssetsVolume: z.number().nullable().optional(),
    stateOfAffairs: z.string().nullable().optional(),
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
    companyFacts: z.record(z.string(), z.unknown()).nullable().optional(),
    companyObservations: z.record(z.string(), z.unknown()).nullable().optional(),
    companySignals: z.record(z.string(), z.unknown()).nullable().optional(),
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

// Gateway stamps `companyId` onto each upstream row in the errors fan-out
// (transactions.ts) so the Desktop-App can group without a re-lookup.
export const ProcessingErrorShape = z
  .object({
    id: z.string(),
    companyId: z.string(),
    transactionId: z.string(),
    errorReason: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("ProcessingError");
