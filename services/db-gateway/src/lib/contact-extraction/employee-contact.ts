import { createHash } from "crypto";
import { buildSignalDedupKey } from "./hashing";
import { PrismaClient, EntityType } from "../../../generated/company-contact-client";
import {
  createObservationIdempotent,
  CreateObservationInput,
} from "./observation";
import { reconcileEntity } from "./reconcile-entity";

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function personIdentityKey(args: {
  companyId: string;
  fullName: string;
  linkedinUrl?: string | null;
  xingUrl?: string | null;
}): string {
  const url = (args.linkedinUrl || args.xingUrl || "").trim().toLowerCase();
  if (url) return `url:${url}`;
  const name = args.fullName.trim().toLowerCase();
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

  const existing = await prisma.person.findFirst({
    where: {
      personFacts: {
        some: {
          field: "identityKey",
          normalized: key,
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

  if (args.candidate.linkedinUrl) {
    obs.push({
      entityType: "PERSON" as EntityType,
      entityId: args.personId,
      personId: args.personId,
      field: "linkedinUrl",
      value: args.candidate.linkedinUrl,
      source: args.source,
      evidenceUrl: args.evidenceUrl ?? null,
      evidence: null,
      companyId: args.companyId,
    });
  }

  if (args.candidate.xingUrl) {
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
