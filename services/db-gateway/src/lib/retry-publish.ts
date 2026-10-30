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
  type EventPayload,
  CompanyContactUpsertPayload,
  EventBuilder,
  StructuredContentUpsertPayload,
  WebsiteUpsertPayload,
} from "@ava/event";
import { HTTPException } from "hono/http-exception";

import { getGatewayAmqpPublisher } from "./amqp-publisher";
import { getProducerPool } from "./producer-pools";
import { getContactPrismaClient } from "./contact-prisma";
import { targetUserRoutingKey } from "./per-user-routing";
import { loadEnv } from "./env";
import { randomUUID } from "node:crypto";

const ALL_PRODUCER_SERVICES = [
  "structured-content",
  "company-publication",
  "website",
  "company-profile",
  "company-contact",
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
 * `stage` is one of: "website" | "companyProfile".
 */
export async function publishStructuredContentRetry(opts: {
  stage: "website" | "companyProfile";
  transactionId: string;
  companyId: string;
  source: string;
  /** v0.1.53 — JWT subject for per-user AMQP routing. */
  userId: string;
  /** Nur diese Producer sollen das Ereignis verarbeiten (Standard: alle,
   *  damit die Kaskade laeuft). Der manuelle Recherche-Lauf setzt
   *  ["website"], weil er keine Folgeereignisse will. */
  services?: string[];
}): Promise<{ published: number }> {
  const { stage, transactionId, companyId, source, userId } = opts;
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
  const header = { ...baseHeader(transactionId, companyId, source), ...(opts.services ? { services: opts.services } : {}) };
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
    await client.publish(env.EVENT_BUS_EXCHANGE, targetUserRoutingKey(event, userId));
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
    await client.publish(env.EVENT_BUS_EXCHANGE, targetUserRoutingKey(event, userId));
    return { published: 1 };
  }

  notFound(`Stage ${stage} kann fuer structured-content nicht wiederholt werden`);
}

// =============================================================================
// website
// =============================================================================

/**
 * Republishes website's slice for the requested stage.
 * `stage` is one of: "companyProfile" | "companyContact".
 *
 * `companyName` is required for stage="companyContact" (mirrors the
 * legacy command).
 */
export async function publishWebsiteRetry(opts: {
  stage: "companyProfile" | "companyContact";
  transactionId: string;
  companyId: string;
  companyName?: string;
  source: string;
  /** v0.1.53 — JWT subject for per-user AMQP routing. */
  userId: string;
  /** Fokus-Lauf (Buying Center, 2026-09-22): doppeltes Crawl-Budget, URL-
   *  Richter immer, Personen-Durchgang immer. Reist im CloudEvent-Attribut
   *  `source` als Suffix "#fokus": Der AMQP-Client des Producers laesst
   *  Nutzdaten durch den Payload-Generator (nur url + companyName
   *  ueberleben), `source` kommt aber unveraendert an. */
  fokus?: boolean;
}): Promise<{ published: number }> {
  const { stage, transactionId, companyId, companyName, source, userId, fokus } = opts;
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
  const header = baseHeader(transactionId, companyId, fokus ? `${source}#fokus` : source);
  const env = loadEnv();
  const client = await getGatewayAmqpPublisher();

  if (stage === "companyProfile") {
    const event: CloudEvent<WebsiteUpsertPayload> =
      new EventBuilder().website.upsert.header(header).data({ url }).build();
    await client.publish(env.EVENT_BUS_EXCHANGE, targetUserRoutingKey(event, userId));
    return { published: 1 };
  }

  if (stage === "companyContact") {
    // v0.1.378 — companyName ist für die companyContact-Slice Pflicht, der
    // Heartbeat-Auto-Retry schickt ihn aber NICHT mit (nur transactionId/
    // companyId). Vorher scheiterte das hart mit 400 und die Zeile blieb in
    // der Retry-Queue → Dauer-Hammer. Jetzt laden wir den Namen aus dem
    // Structured-Content-Store nach (dort steht `sc.name`); nur wenn auch
    // der fehlt, ist der Retry wirklich aussichtslos → notFound (404), das
    // der Retry-Handler als „giveUp" terminalisiert.
    let resolvedName = companyName;
    if (!resolvedName) {
      const loaded = await loadStructuredContent(companyId);
      resolvedName = loaded?.sc.name ?? undefined;
    }
    if (!resolvedName) {
      notFound(
        `No companyName for ${companyId} (caller omitted it, none in structured content); cannot retry companyContact`,
      );
    }
    const event: CloudEvent<CompanyContactUpsertPayload> =
      new EventBuilder().website.upsertCompanyContact
        .header(header)
        .data({ url, companyName: resolvedName })
        .build();
    await client.publish(env.EVENT_BUS_EXCHANGE, targetUserRoutingKey(event, userId));
    return { published: 1 };
  }

  notFound(`Stage ${stage} kann fuer website nicht wiederholt werden`);
}

// =============================================================================
// company-email (docs/PLAN_EMAIL_VERIFIZIERUNG.md, V5)
// =============================================================================

/** Form des Triggers `companyContact.createEmailVerification`, wie ihn der
 *  Contact-Producer am Ende seines Laufs sendet (company-contact/src/
 *  infrastructure/events/email/publish-email-verification-trigger.ts). Von
 *  Hand gebaut: das registry-@ava/event (1.1.40) kennt den Typ noch nicht. */
export const EMAIL_VERIFICATION_TYPE = "companyContact.createEmailVerification";

export function buildEmailVerificationRetry(args: {
  source: string;
  companyId: string;
  transactionId: string;
  companyName: string;
  url?: string;
  now?: Date;
}): CloudEvent<EventPayload> {
  const jetzt = args.now ?? new Date();
  return {
    id: randomUUID(),
    specversion: "1.0",
    datacontenttype: "application/json",
    time: jetzt.toISOString(),
    type: EMAIL_VERIFICATION_TYPE,
    source: args.source,
    subject: args.companyId,
    transaction: args.transactionId,
    services: ALL_PRODUCER_SERVICES,
    data: {
      companyName: args.companyName,
      ...(args.url ? { url: args.url } : {}),
      // Kontakte sind unveraendert: company-email liest den aktuellen Stand
      // und wartet nicht auf einen neuen Contact-Persist.
      kontakteGeaendert: false,
      contactRunAt: jetzt.toISOString(),
    },
  } as unknown as CloudEvent<EventPayload>;
}

/**
 * Stufe "E-Mail" allein wiederholen: Trigger des Contact-Producers neu senden,
 * ohne Website-Crawl und Kontaktextraktion. Firmenname aus dem Register,
 * Website-URL (optional) aus dem Website-Store.
 */
export async function publishCompanyEmailRetry(opts: {
  transactionId: string;
  companyId: string;
  companyName?: string;
  source: string;
  userId: string;
}): Promise<{ published: number }> {
  const { transactionId, companyId, source, userId } = opts;
  let companyName = opts.companyName;
  if (!companyName) {
    const loaded = await loadStructuredContent(companyId);
    companyName = loaded?.sc.name ?? undefined;
  }
  if (!companyName) {
    notFound(`No companyName for ${companyId}; cannot retry companyEmail`);
  }
  let url: string | undefined;
  try {
    const res = await getProducerPool("website").query<{ url: string | null }>(
      `SELECT url FROM "Website" WHERE "companyId" = $1 LIMIT 1`,
      [companyId],
    );
    url = res.rows[0]?.url ?? undefined;
  } catch {
    /* ohne URL: company-email nimmt die Website aus den Kontaktdaten */
  }
  const event = buildEmailVerificationRetry({ source, companyId, transactionId, companyName, url });
  const env = loadEnv();
  const client = await getGatewayAmqpPublisher();
  await client.publish(env.EVENT_BUS_EXCHANGE, targetUserRoutingKey(event, userId));
  return { published: 1 };
}
