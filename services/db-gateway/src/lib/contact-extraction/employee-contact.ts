import { createHash } from "crypto";
import { buildSignalDedupKey } from "./hashing";
import { PrismaClient, EntityType } from "../../../generated/company-contact-client";
import {
  createObservationIdempotent,
  CreateObservationInput,
} from "./observation";
import { reconcileEntity } from "./reconcile-entity";
import { nameIdentityForm } from "./sanitize-person";

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

// v0.1.189-Port — Host-Gate fuer Personen-Profil-URLs. Das LLM haengt
// gelegentlich CDN-Avatar-URLs an das linkedinUrl-Feld; ohne Gate wird
// so eine Bild-URL zum Identitaetsschluessel UND zum klickbaren Badge.
function isHostFor(
  url: string | undefined | null,
  allowedHosts: ReadonlyArray<string>,
): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return allowedHosts.some((h) => host === h || host.endsWith("." + h));
  } catch {
    return false;
  }
}
const LINKEDIN_HOSTS = ["linkedin.com", "lnkd.in"];
const XING_HOSTS = ["xing.com"];

/**
 * v0.1.476 — WL0-Konsequenz 1: LinkedIn-PROFIL-Normalisierung.
 *
 * Das reine Host-Gate liess Post-URLs (linkedin.com/posts/…) und
 * Varianten-Duplikate (www./Laender-Subdomain/Trailing-Slash/Locale-
 * Suffix) durch. Ab jetzt gilt: Nur /in/-Profile zaehlen als
 * linkedinUrl, und sie werden auf EINE kanonische Form gebracht:
 *   https://www.linkedin.com/in/<slug>   (Slug decodiert, lowercase,
 *   wieder encodiert; de./uk./tr. → www; kein Slash/Query/Locale).
 * Kurzlinks (lnkd.in) sind KEINE Profil-Belege — sie werden verworfen.
 * Liefert null fuer alles, was kein Profil ist.
 */
export function normalizeLinkedInProfileUrl(
  raw: string | null | undefined,
): string | null {
  if (!raw) return null;
  // Menschliche Eingaben kommen oft ohne Schema ("linkedin.com/in/x") —
  // tolerieren statt ablehnen.
  const trimmed = raw.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  if (host !== "linkedin.com" && !host.endsWith(".linkedin.com")) return null;
  const m = /^\/in\/([^/]+)/.exec(u.pathname);
  if (!m || !m[1]) return null;
  let slug: string;
  try {
    slug = decodeURIComponent(m[1]).trim().toLowerCase();
  } catch {
    slug = m[1].trim().toLowerCase();
  }
  if (!slug) return null;
  return `https://www.linkedin.com/in/${encodeURIComponent(slug)}`;
}

export function personIdentityKey(args: {
  companyId: string;
  fullName: string;
  linkedinUrl?: string | null;
  xingUrl?: string | null;
}): string {
  // Nur echte Profil-URLs duerfen Identitaet stiften — LinkedIn ab
  // v0.1.476 in kanonischer Form (dedupt www-/Subdomain-Varianten).
  const gatedUrl =
    normalizeLinkedInProfileUrl(args.linkedinUrl) ??
    (isHostFor(args.xingUrl, XING_HOSTS) ? args.xingUrl : null);
  const url = (gatedUrl ?? "").trim().toLowerCase();
  if (url) return `url:${url}`;
  // Titel-/Diakritik-gefaltete Namensform: "Dr. Anna Meier" und
  // "Anna Meier" sind dieselbe Person. Fuer schlichte Namen identisch
  // zur alten lowercase-Form → bestehende Schluessel bleiben stabil.
  const name = nameIdentityForm(args.fullName);
  return `name:${sha256(`${args.companyId}|${name}`)}`;
}

export type EmployeeCandidate = {
  fullName: string;
  title?: string;
  department?: string;
  location?: string;
  linkedinUrl?: string;
  xingUrl?: string;
  email?: string;
  phone?: string;
  sourceUrl?: string;
  source?: string;
};

export async function upsertPersonByIdentity(
  prisma: PrismaClient,
  args: {
    companyId: string;
    candidate: EmployeeCandidate;
  },
) {
  const key = personIdentityKey({
    companyId: args.companyId,
    fullName: args.candidate.fullName,
    linkedinUrl: args.candidate.linkedinUrl ?? null,
    xingUrl: args.candidate.xingUrl ?? null,
  });

  // v0.1.476 — Bestandsschutz: Alt-Schluessel wurden aus der ROHEN
  // URL gebaut (vor der Profil-Normalisierung). Beim Lookup werden
  // beide Formen gesucht, damit ein Re-Scrape derselben Person keine
  // Dublette anlegt.
  const legacyGated = isHostFor(args.candidate.linkedinUrl, LINKEDIN_HOSTS)
    ? args.candidate.linkedinUrl
    : isHostFor(args.candidate.xingUrl, XING_HOSTS)
      ? args.candidate.xingUrl
      : null;
  const legacyUrl = (legacyGated ?? "").trim().toLowerCase();
  const keys = [key];
  if (legacyUrl && `url:${legacyUrl}` !== key) keys.push(`url:${legacyUrl}`);

  const existing = await prisma.person.findFirst({
    where: {
      personFacts: {
        some: {
          field: "identityKey",
          normalized: { in: keys },
        },
      },
    },
  });

  if (existing)
    return { personId: existing.id, created: false, identityKey: key };

  const created = await prisma.person.create({
    data: {
      fullName: args.candidate.fullName,
      location: args.candidate.location ?? null,
      givenName: null,
      familyName: null,
    },
  });

  return { personId: created.id, created: true, identityKey: key };
}

export function buildPersonObservations(args: {
  personId: string;
  identityKey: string;
  companyId: string;
  candidate: {
    fullName: string;
    title?: string;
    department?: string;
    linkedinUrl?: string;
    xingUrl?: string;
    email?: string;
    phone?: string;
  };
  source: string;
  evidenceUrl?: string | null;
  defaultCountryCode?: string;
}): CreateObservationInput[] {
  const obs: CreateObservationInput[] = [];

  obs.push({
    entityType: "PERSON" as EntityType,
    entityId: args.personId,
    personId: args.personId,
    field: "identityKey",
    value: args.identityKey,
    source: args.source,
    evidenceUrl: args.evidenceUrl ?? null,
    evidence: null,
    companyId: args.companyId,
  });

  obs.push({
    entityType: "PERSON" as EntityType,
    entityId: args.personId,
    personId: args.personId,
    field: "fullName",
    value: args.candidate.fullName,
    source: args.source,
    evidenceUrl: args.evidenceUrl ?? null,
    evidence: null,
    companyId: args.companyId,
  });

  const linkedinProfile = normalizeLinkedInProfileUrl(
    args.candidate.linkedinUrl,
  );
  if (linkedinProfile) {
    obs.push({
      entityType: "PERSON" as EntityType,
      entityId: args.personId,
      personId: args.personId,
      field: "linkedinUrl",
      // Kanonische Form persistieren — dedupt Varianten am Nadeloehr.
      value: linkedinProfile,
      source: args.source,
      evidenceUrl: args.evidenceUrl ?? null,
      evidence: null,
      companyId: args.companyId,
    });
  }

  if (args.candidate.xingUrl && isHostFor(args.candidate.xingUrl, XING_HOSTS)) {
    obs.push({
      entityType: "PERSON" as EntityType,
      entityId: args.personId,
      personId: args.personId,
      field: "xingUrl",
      value: args.candidate.xingUrl,
      source: args.source,
      evidenceUrl: args.evidenceUrl ?? null,
      evidence: null,
      companyId: args.companyId,
    });
  }

  if (args.candidate.title) {
    obs.push({
      entityType: "PERSON" as EntityType,
      entityId: args.personId,
      personId: args.personId,
      field: "jobTitle",
      value: args.candidate.title,
      source: args.source,
      evidenceUrl: args.evidenceUrl ?? null,
      evidence: null,
      companyId: args.companyId,
    });
  }

  if (args.candidate.department) {
    obs.push({
      entityType: "PERSON" as EntityType,
      entityId: args.personId,
      personId: args.personId,
      field: "department",
      value: args.candidate.department,
      source: args.source,
      evidenceUrl: args.evidenceUrl ?? null,
      evidence: null,
      companyId: args.companyId,
    });
  }

  if (args.candidate.email) {
    obs.push({
      entityType: "PERSON" as EntityType,
      entityId: args.personId,
      personId: args.personId,
      field: "email",
      value: args.candidate.email,
      source: args.source,
      evidenceUrl: args.evidenceUrl ?? null,
      evidence: null,
      defaultCountryCode: args.defaultCountryCode,
      companyId: args.companyId,
    });
  }

  if (args.candidate.phone) {
    obs.push({
      entityType: "PERSON" as EntityType,
      entityId: args.personId,
      personId: args.personId,
      field: "phone",
      value: args.candidate.phone,
      source: args.source,
      evidenceUrl: args.evidenceUrl ?? null,
      evidence: null,
      defaultCountryCode: args.defaultCountryCode,
      companyId: args.companyId,
    });
  }

  obs.push({
    entityType: "PERSON" as EntityType,
    entityId: args.personId,
    personId: args.personId,
    field: "employmentCompanyId",
    value: args.companyId,
    source: args.source,
    evidenceUrl: args.evidenceUrl ?? null,
    evidence: null,
    companyId: args.companyId,
  });

  return obs;
}

export async function persistObservations(
  prisma: PrismaClient,
  args: {
    runId: string;
    observations: CreateObservationInput[];
  },
) {
  const ids: string[] = [];
  for (const o of args.observations) {
    const created = await createObservationIdempotent(prisma, {
      ...o,
      runId: args.runId,
    });
    ids.push(created.id);
  }
  return ids;
}

export async function reconcilePerson(
  prisma: PrismaClient,
  args: {
    runId: string;
    personId: string;
  },
) {
  const policy = {
    multiValueFields: new Set<string>(["email", "phone"].map(String)),
    changeFields: new Set<string>(
      ["jobTitle", "employmentCompanyId"].map(String),
    ),
    inactiveOnNewForFields: new Set<string>(
      ["jobTitle", "employmentCompanyId"].map(String),
    ),
  };

  return reconcileEntity(prisma, {
    entityType: "PERSON" as EntityType,
    entityId: args.personId,
    personId: args.personId,
    runId: args.runId,
    observedAfter: null,
    policy,
  });
}

export async function emitEmployerChangeSignal(
  prisma: PrismaClient,
  args: {
    runId: string;
    personId: string;
    source?: string | null;
    evidenceUrl?: string | null;
  },
) {
  const facts = await prisma.fact.findMany({
    where: {
      entityType: "PERSON" as EntityType,
      entityId: args.personId,
      field: "employmentCompanyId",
    },
    orderBy: { lastSeen: "desc" },
  });

  const active = facts.find((f) => f.status === "ACTIVE");
  if (!active) return null;

  const previous = facts.find(
    (f) => f.id !== active.id && f.status === "INACTIVE",
  );
  if (!previous) return null;

  const dedupKey = buildSignalDedupKey({
    entityType: "PERSON",
    entityId: args.personId,
    type: "PERSON_EMPLOYER_CHANGED",
    field: "employmentCompanyId",
    afterNorm: active.normalized,
  });

  const signal = await prisma.signalEvent.upsert({
    where: { dedupKey },
    update: {
      observedAt: new Date(),
      runId: args.runId,
      source: args.source ?? undefined,
      evidenceUrl: args.evidenceUrl ?? undefined,
      before: previous.value,
      beforeNorm: previous.normalized,
      after: active.value,
      afterNorm: active.normalized,
    },
    create: {
      type: "PERSON_EMPLOYER_CHANGED",
      entityType: "PERSON",
      entityId: args.personId,
      personId: args.personId,
      field: "employmentCompanyId",
      before: previous.value,
      beforeNorm: previous.normalized,
      after: active.value,
      afterNorm: active.normalized,
      confidence: 0.75,
      reason: "employment_company_changed",
      source: args.source ?? null,
      evidenceUrl: args.evidenceUrl ?? null,
      observedAt: new Date(),
      runId: args.runId,
      dedupKey,
    },
  });

  await prisma.factSignalLink
    .create({
      data: { factId: active.id, signalId: signal.id },
    })
    .catch(() => null);

  return signal.id;
}
