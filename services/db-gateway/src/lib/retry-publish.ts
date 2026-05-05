// Gateway-side ports of the four localized producers' retry-stage
// commands (§8.v3 Phase 1.5).
//
// Pre-§8.v3 the desktop's "Retry stage" button POSTed to the gateway,
// which proxied to the per-producer fly app's `/api/v1/transactions/
// :tid/retry`. Each producer read its own DB row and republished the
// matching AMQP event so the downstream consumer re-ran. With the
// fly producer apps targeted for destroy in Phase 4, that proxy path
// stops working; this module reproduces the same logic against MPG.
//
// One helper per producer. Each:
//   1. SELECTs the producer's persisted row(s) via the producer pool
//   2. Throws NotFound if there's nothing to republish from
//   3. Builds the same CloudEvent the legacy command did
//   4. Publishes via the shared gateway publisher
//
// Dispatch-side is in routes/v1/transactions.ts: the retry route
// classifies each target as either `masterData` (still goes through
// callUpstream — master-data is fly-permanent) or one of the four
// localized producers (calls into here).
//
// Notes on the `services` array: producers gate event handling on
// `services.includes(self)`. Cascading downstream events forward the
// array. Listing only the immediate target breaks the cascade, so we
// always send the full producer set — same convention master-data and
// the original per-producer commands used. Privileged retry context.

import {
  CloudEvent,
  CompanyContactUpsertPayload,
  EvaluationUpsertCompanyProfilePayload,
  EvaluationUpsertCompanySerpPayload,
  EvaluationUpsertDeepResearchPayload,
  EvaluationUpsertJobPostingsPayload,
  EvaluationUpsertKeyFiguresPayload,
  EvaluationUpsertKeywordsPayload,
  EvaluationUpsertStructuredContentPayload,
  EventBuilder,
  StructuredContentUpsertPayload,
  WebsiteUpsertPayload,
} from "@ava/event";
import { HTTPException } from "hono/http-exception";

import { getGatewayAmqpPublisher } from "./amqp-publisher";
import { getProducerPool } from "./producer-pools";
import { loadEnv } from "./env";

const ALL_PRODUCER_SERVICES = [
  "structured-content",
  "company-publication",
  "website",
  "company-profile",
  "company-contact",
  "company-evaluation",
];

function notFound(message: string): never {
  throw new HTTPException(404, { message });
}

interface BaseHeader {
  source: string;
  subject: string;
  transaction: string;
  services: string[];
}

function baseHeader(transactionId: string, companyId: string, source: string): BaseHeader {
  return {
    source,
    subject: companyId,
    transaction: transactionId,
    services: ALL_PRODUCER_SERVICES,
  };
}

// =============================================================================
// structured-content
// =============================================================================

interface StructuredContentRow {
  companyId: string;
  name: string;
  street: string;
  houseNumber: string;
  zipCode: string;
  city: string;
  corporatePurpose: string | null;
}

interface ManagingDirectorRow {
  firstName: string;
  lastName: string;
  city: string | null;
  birthDay: Date | null;
}

async function loadStructuredContent(
  companyId: string,
): Promise<{ sc: StructuredContentRow; mds: ManagingDirectorRow[] } | null> {
  const pool = getProducerPool("structured-content");
  const scRes = await pool.query<StructuredContentRow>(
    `SELECT "companyId", name, street, "houseNumber", "zipCode", city, "corporatePurpose"
     FROM "StructuredContent" WHERE "companyId" = $1 LIMIT 1`,
    [companyId],
  );
  if (scRes.rowCount === 0) return null;
  const mdRes = await pool.query<ManagingDirectorRow>(
    `SELECT "firstName", "lastName", city, "birthDay"
     FROM "ManagingDirector" WHERE "companyId" = $1`,
    [companyId],
  );
  return { sc: scRes.rows[0], mds: mdRes.rows };
}

/**
 * Republishes structured-content's slice for the requested stage.
 * `stage` is one of: "website" | "companyProfile" | "companyEvaluation".
 */
export async function publishStructuredContentRetry(opts: {
  stage: "website" | "companyProfile" | "companyEvaluation";
  transactionId: string;
  companyId: string;
  source: string;
}): Promise<{ published: number }> {
  const { stage, transactionId, companyId, source } = opts;
  const loaded = await loadStructuredContent(companyId);
  if (!loaded) {
    notFound(`No structured content for company ${companyId}; cannot retry stage ${stage}`);
  }
  const { sc, mds } = loaded;
  const managingDirectors = mds.map((md) => ({
    city: md.city,
    birthDay: md.birthDay,
    lastName: md.lastName,
    firstName: md.firstName,
  }));
  const header = baseHeader(transactionId, companyId, source);
  const env = loadEnv();
  const client = await getGatewayAmqpPublisher();

  if (stage === "website") {
    const event: CloudEvent<StructuredContentUpsertPayload> =
      new EventBuilder().structuredContent.upsert
        .header(header)
        .data({
          companyId: sc.companyId,
          name: sc.name,
          street: sc.street,
          houseNumber: sc.houseNumber,
          zipCode: sc.zipCode,
          city: sc.city,
          businessPurpose: sc.corporatePurpose ?? undefined,
          managingDirectors,
        })
        .build();
    await client.publish(env.EVENT_BUS_EXCHANGE, event);
    return { published: 1 };
  }

  if (stage === "companyProfile") {
    const event: CloudEvent<StructuredContentUpsertPayload> =
      new EventBuilder().structuredContent.upsertCompanyProfile
        .header(header)
        .data({
          companyId: sc.companyId,
          name: sc.name,
          street: sc.street,
          houseNumber: sc.houseNumber,
          zipCode: sc.zipCode,
          city: sc.city,
          businessPurpose: sc.corporatePurpose ?? undefined,
          managingDirectors,
        })
        .build();
    await client.publish(env.EVENT_BUS_EXCHANGE, event);
    return { published: 1 };
  }

  // companyEvaluation: structured-content's slice of the evaluation
  // fan-out. Requires corporatePurpose (the original publish-site
  // asserted non-null); skip cleanly without it.
  if (!sc.corporatePurpose) {
    notFound(
      `Structured content for ${companyId} has no corporatePurpose; cannot retry evaluation slice`,
    );
  }
  const event: CloudEvent<EvaluationUpsertStructuredContentPayload> =
    new EventBuilder().companyEvaluation.upsertStructuredContent
      .header(header)
      .data({
        companyId: sc.companyId,
        companyName: sc.name,
        name: sc.name,
        street: sc.street,
        houseNumber: sc.houseNumber,
        zipCode: sc.zipCode,
        city: sc.city,
        businessPurpose: sc.corporatePurpose,
        managingDirectors,
      })
      .build();
  await client.publish(env.EVENT_BUS_EXCHANGE, event);
  return { published: 1 };
}

// =============================================================================
// website
// =============================================================================

/**
 * Republishes website's slice for the requested stage.
 * `stage` is one of: "companyProfile" | "companyContact" | "companyEvaluation".
 *
 * `companyName` is required for stage="companyContact" (mirrors the
 * legacy command).
 */
export async function publishWebsiteRetry(opts: {
  stage: "companyProfile" | "companyContact" | "companyEvaluation";
  transactionId: string;
  companyId: string;
  companyName?: string;
  source: string;
}): Promise<{ published: number }> {
  const { stage, transactionId, companyId, companyName, source } = opts;
  const pool = getProducerPool("website");
  const websiteRes = await pool.query<{ url: string | null }>(
    `SELECT url FROM "Website" WHERE "companyId" = $1 LIMIT 1`,
    [companyId],
  );
  if (websiteRes.rowCount === 0 || !websiteRes.rows[0].url) {
    notFound(
      `No website (or no URL) for company ${companyId}; cannot retry stage ${stage}`,
    );
  }
  const url = websiteRes.rows[0].url as string;
  const header = baseHeader(transactionId, companyId, source);
  const env = loadEnv();
  const client = await getGatewayAmqpPublisher();

  if (stage === "companyProfile") {
    const event: CloudEvent<WebsiteUpsertPayload> =
      new EventBuilder().website.upsert.header(header).data({ url }).build();
    await client.publish(env.EVENT_BUS_EXCHANGE, event);
    return { published: 1 };
  }

  if (stage === "companyContact") {
    if (!companyName) {
      throw new HTTPException(400, {
        message: `companyName is required to retry companyContact for ${companyId}`,
      });
    }
    const event: CloudEvent<CompanyContactUpsertPayload> =
      new EventBuilder().website.upsertCompanyContact
        .header(header)
        .data({ url, companyName })
        .build();
    await client.publish(env.EVENT_BUS_EXCHANGE, event);
    return { published: 1 };
  }

  // companyEvaluation: re-emit website's three evaluation slices.
  // Each is conditional on the corresponding child row existing in MPG.
  let published = 0;

  const serpRes = await pool.query<{
    address: string | null;
    latitude: number | null;
    longitude: number | null;
    category: string | null;
  }>(
    `SELECT address, latitude, longitude, category
     FROM "CompanySerp" WHERE "companyId" = $1 LIMIT 1`,
    [companyId],
  );
  if ((serpRes.rowCount ?? 0) > 0) {
    const serp = serpRes.rows[0];
    const event: CloudEvent<EvaluationUpsertCompanySerpPayload> =
      new EventBuilder().companyEvaluation.upsertCompanySerp
        .header(header)
        .data({
          address: serp.address ?? undefined,
          latitude: serp.latitude ?? undefined,
          longitude: serp.longitude ?? undefined,
          category: serp.category ?? undefined,
        })
        .build();
    await client.publish(env.EVENT_BUS_EXCHANGE, event);
    published += 1;
  }

  const drRes = await pool.query<{
    company: string | null;
    type: string;
    title: string;
    country: string | null;
    value: string | null;
    date: string | null;
    url: string;
    citations: string[];
  }>(
    `SELECT company, type, title, country, value, date, url, citations
     FROM "DeepResearch" WHERE "companyId" = $1`,
    [companyId],
  );
  if ((drRes.rowCount ?? 0) > 0) {
    const event: CloudEvent<EvaluationUpsertDeepResearchPayload> =
      new EventBuilder().companyEvaluation.upsertDeepResearch
        .header(header)
        .data({
          deepResearches: drRes.rows.map((r) => ({
            company: r.company ?? undefined,
            type: r.type,
            title: r.title,
            country: r.country ?? undefined,
            value: r.value ?? undefined,
            date: r.date ?? undefined,
            url: r.url,
            citations: r.citations ?? [],
          })),
        })
        .build();
    await client.publish(env.EVENT_BUS_EXCHANGE, event);
    published += 1;
  }

  const jpRes = await pool.query<{
    title: string;
    location: string | null;
    workingModel: string | null;
    description: string | null;
    requirements: string[];
    technologies: string[];
    sourceUrl: string;
    releaseDate: Date | null;
  }>(
    `SELECT title, location, "workingModel", description,
            requirements, technologies, "sourceUrl", "releaseDate"
     FROM "JobPosting" WHERE "companyId" = $1`,
    [companyId],
  );
  if ((jpRes.rowCount ?? 0) > 0) {
    const event: CloudEvent<EvaluationUpsertJobPostingsPayload> =
      new EventBuilder().companyEvaluation.upsertJobPostings
        .header(header)
        .data({
          jobPostings: jpRes.rows.map((r) => ({
            title: r.title,
            location: r.location ?? undefined,
            workingModel: r.workingModel ?? undefined,
            description: r.description ?? undefined,
            requirements: r.requirements ?? [],
            technologies: r.technologies ?? [],
            sourceUrl: r.sourceUrl,
            releaseDate: r.releaseDate ?? undefined,
          })),
        })
        .build();
    await client.publish(env.EVENT_BUS_EXCHANGE, event);
    published += 1;
  }

  if (published === 0) {
    notFound(`No evaluation slices to republish for ${companyId}`);
  }
  return { published };
}

// =============================================================================
// company-profile
// =============================================================================

/**
 * Republishes company-profile's slices to company-evaluation. The legacy
 * command only handled stage="companyEvaluation"; we keep that semantics.
 */
export async function publishCompanyProfileRetry(opts: {
  transactionId: string;
  companyId: string;
  source: string;
}): Promise<{ published: number }> {
  const { transactionId, companyId, source } = opts;
  const pool = getProducerPool("company-profile");

  const profileRes = await pool.query<{ profile: string | null }>(
    `SELECT profile FROM "CompanyProfile" WHERE id = $1 LIMIT 1`,
    [companyId],
  );
  const keywordsRes = await pool.query<{ keyword: string }>(
    `SELECT keyword FROM "CompanyKeyword" WHERE "companyId" = $1`,
    [companyId],
  );

  const header = baseHeader(transactionId, companyId, source);
  const env = loadEnv();
  const client = await getGatewayAmqpPublisher();
  let published = 0;

  if ((profileRes.rowCount ?? 0) > 0 && profileRes.rows[0].profile) {
    const event: CloudEvent<EvaluationUpsertCompanyProfilePayload> =
      new EventBuilder().companyEvaluation.upsertCompanyProfile
        .header(header)
        .data({ profile: profileRes.rows[0].profile as string })
        .build();
    await client.publish(env.EVENT_BUS_EXCHANGE, event);
    published += 1;
  }

  if ((keywordsRes.rowCount ?? 0) > 0) {
    const event: CloudEvent<EvaluationUpsertKeywordsPayload> =
      new EventBuilder().companyEvaluation.upsertKeywords
        .header(header)
        .data({ keywords: keywordsRes.rows.map((r) => r.keyword) })
        .build();
    await client.publish(env.EVENT_BUS_EXCHANGE, event);
    published += 1;
  }

  if (published === 0) {
    notFound(
      `No company profile or keywords for ${companyId}; nothing to republish`,
    );
  }
  return { published };
}

// =============================================================================
// company-publication
// =============================================================================

/**
 * Republishes company-publication's evaluation key-figures slice. Pulls
 * every publication for the company, rolls them up into the same payload
 * shape the legacy command + the §8.v3 compute-worker emit.
 */
export async function publishCompanyPublicationRetry(opts: {
  transactionId: string;
  companyId: string;
  source: string;
}): Promise<{ published: number }> {
  const { transactionId, companyId, source } = opts;
  const pool = getProducerPool("company-publication");

  const rows = await pool.query<{
    year: number;
    employeeCount: number | null;
    salesValue: string | null;
    salesCurrency: string | null;
    revenueValue: string | null;
    revenueCurrency: string | null;
    totalAssetsValue: string | null;
    totalAssetsCurrency: string | null;
    soaId: number | null;
    soaIsRelevant: boolean | null;
    soaTopic: string | null;
    soaBullets: string[] | null;
    soaGuidance: string[] | null;
    soaRisksOpportunities: string[] | null;
  }>(
    `SELECT
       cp.year,
       cp."employeeCount",
       sv.value::text AS "salesValue", sv.currency AS "salesCurrency",
       rv.value::text AS "revenueValue", rv.currency AS "revenueCurrency",
       tv.value::text AS "totalAssetsValue", tv.currency AS "totalAssetsCurrency",
       soa.id AS "soaId",
       soa."isRelevant" AS "soaIsRelevant",
       soa.topic::text AS "soaTopic",
       soa.bullets AS "soaBullets",
       soa.guidance AS "soaGuidance",
       soa."risksOpportunities" AS "soaRisksOpportunities"
     FROM "CompanyPublication" cp
     LEFT JOIN "SalesVolume" sv ON sv."companyPublicationId" = cp.id
     LEFT JOIN "RevenueVolume" rv ON rv."companyPublicationId" = cp.id
     LEFT JOIN "TotalAssetsVolume" tv ON tv."companyPublicationId" = cp.id
     LEFT JOIN "StateOfAffairsAggregate" soa ON soa."companyPublicationId" = cp.id
     WHERE cp."companyId" = $1`,
    [companyId],
  );
  if (rows.rowCount === 0) {
    notFound(`No company publications for ${companyId}; cannot retry`);
  }

  // Pull KPIs for any aggregates present, group by aggregateId.
  const aggregateIds = rows.rows
    .map((r) => r.soaId)
    .filter((id): id is number => id !== null);
  const kpisByAggregate = new Map<
    number,
    Array<{ name: string; value: string; period?: string }>
  >();
  if (aggregateIds.length > 0) {
    const kpiRes = await pool.query<{
      aggregateId: number;
      name: string;
      value: string;
      period: string | null;
    }>(
      `SELECT "aggregateId", name, value, period
       FROM "StateOfAffairsKPI"
       WHERE "aggregateId" = ANY($1::int[])`,
      [aggregateIds],
    );
    for (const k of kpiRes.rows) {
      let arr = kpisByAggregate.get(k.aggregateId);
      if (!arr) {
        arr = [];
        kpisByAggregate.set(k.aggregateId, arr);
      }
      arr.push({
        name: k.name,
        value: k.value,
        period: k.period ?? undefined,
      });
    }
  }

  // The fields on EvaluationUpsertKeyFiguresPayload are all optional,
  // so we can't index `Payload["sales"][number]["currency"]` directly.
  // Cast through the runtime shape — currency strings + JSONB
  // pass-through for stateOfAffairs.
  type Money = NonNullable<EvaluationUpsertKeyFiguresPayload["sales"]>[number];
  type SoaEntry = NonNullable<EvaluationUpsertKeyFiguresPayload["stateOfAffairs"]>[number];
  const data: EvaluationUpsertKeyFiguresPayload = {
    sales: rows.rows
      .filter((r) => r.salesValue)
      .map((r): Money => ({
        value: Number(r.salesValue),
        currency: (r.salesCurrency ?? "EURO") as Money["currency"],
        year: r.year,
      })),
    totalAssets: rows.rows
      .filter((r) => r.totalAssetsValue)
      .map((r): Money => ({
        value: Number(r.totalAssetsValue),
        currency: (r.totalAssetsCurrency ?? "EURO") as Money["currency"],
        year: r.year,
      })),
    profits: rows.rows
      .filter((r) => r.revenueValue)
      .map((r): Money => ({
        value: Number(r.revenueValue),
        currency: (r.revenueCurrency ?? "EURO") as Money["currency"],
        year: r.year,
      })),
    employees: rows.rows
      .filter((r) => r.employeeCount != null)
      .map((r) => ({ value: r.employeeCount as number, year: r.year })),
    stateOfAffairs: rows.rows
      .filter((r) => r.soaId !== null)
      .map(
        (r): SoaEntry => ({
          year: r.year,
          isRelevant: r.soaIsRelevant ?? false,
          topic: r.soaTopic ?? "NOTHING",
          bullets: r.soaBullets ?? [],
          guidance: r.soaGuidance ?? [],
          risksOpportunities: r.soaRisksOpportunities ?? [],
          kpis: kpisByAggregate.get(r.soaId as number) ?? [],
        }),
      ),
  };

  const event: CloudEvent<EvaluationUpsertKeyFiguresPayload> =
    new EventBuilder().companyEvaluation.upsertKeyFigures
      .header(baseHeader(transactionId, companyId, source))
      .data(data)
      .build();
  const env = loadEnv();
  const client = await getGatewayAmqpPublisher();
  await client.publish(env.EVENT_BUS_EXCHANGE, event);
  return { published: 1 };
}
