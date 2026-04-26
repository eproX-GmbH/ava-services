import { z } from "@hono/zod-openapi";

// Shared shapes for §4.1 (and everything that follows). Response shapes use
// .passthrough() intentionally — services own the domain, gateway just
// forwards. Tightening these is a Step 7 hardening item.

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

// Loose response wrappers.
export const CompanyShape = z.object({}).passthrough();
export const CompanyProfileShape = z.object({}).passthrough();
export const WebsiteShape = z.object({}).passthrough();
export const StructuredContentShape = z.object({}).passthrough();
export const CompanyPublicationShape = z.object({}).passthrough();
export const CompanyContactShape = z.object({}).passthrough();
export const CompanyKeywordShape = z.object({}).passthrough();

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

export const ErrorShape = z.object({
  error: z.string(),
  message: z.string().optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
});

// §4.2 transaction reads — passthrough shapes (services own the domain).
export const TransactionIdParam = z.object({
  transactionId: z.string().min(1).openapi({ param: { name: "transactionId", in: "path" } }),
});

export const TransactionEntityParams = z.object({
  transactionId: z.string().min(1).openapi({ param: { name: "transactionId", in: "path" } }),
  companyId: z.string().min(1).openapi({ param: { name: "companyId", in: "path" } }),
});

export const TransactionShape = z.object({}).passthrough();
export const EntityTransactionShape = z.object({}).passthrough();
export const ProcessingErrorShape = z.object({}).passthrough();
