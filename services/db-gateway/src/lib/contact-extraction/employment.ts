import type { PrismaClient } from "../../../generated/company-contact-client";
import {
  emitEmployerChangeSignal,
  reconcilePerson,
} from "./employee-contact";
import { buildSignalDedupKey } from "./hashing";

export type PersonEmploymentFacts = {
  employmentCompanyId?: {
    value: string;
    normalized: string;
    factId: string;
  } | null;
  jobTitle?: { value: string; normalized: string; factId: string } | null;
  department?: { value: string; normalized: string; factId: string } | null;
};

export type EmploymentEvidence = {
  source: string;
  url?: string | null;
  snippet?: string | null;
  observedAt: Date;
  runId?: string | null;
};

export async function getActivePersonEmploymentFacts(
  prisma: PrismaClient,
  args: { personId: string },
) {
  const facts = await prisma.fact.findMany({
    where: {
      entityType: "PERSON",
      entityId: args.personId,
      field: { in: ["employmentCompanyId", "jobTitle", "department"] },
      status: "ACTIVE",
    },
    orderBy: { lastSeen: "desc" },
    take: 50,
  });

  const pick = (field: string) => {
    const f = facts.find((x) => x.field === field);
    return f
      ? { value: f.value, normalized: f.normalized, factId: f.id }
      : null;
  };

  const out: PersonEmploymentFacts = {
    employmentCompanyId: pick("employmentCompanyId"),
    jobTitle: pick("jobTitle"),
    department: pick("department"),
  };

  return out;
}

export async function getEmploymentEvidenceFromFacts(
  prisma: PrismaClient,
  args: {
    factIds: string[];
  },
) {
  if (args.factIds.length === 0) return [];

  const links = await prisma.factObservationLink.findMany({
    where: { factId: { in: args.factIds } },
    include: { observation: true },
    orderBy: { observation: { observedAt: "desc" } },
    take: 30,
  });

  const ev: EmploymentEvidence[] = links.map((l) => ({
    source: l.observation.source,
    url: l.observation.evidenceUrl ?? null,
    snippet: l.observation.evidence ?? null,
    observedAt: l.observation.observedAt,
    runId: l.observation.runId ?? null,
  }));

  const seen = new Set<string>();
  const dedup: EmploymentEvidence[] = [];
  for (const e of ev) {
    const k = `${e.source}|${e.url ?? ""}|${(e.snippet ?? "").slice(0, 80)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    dedup.push(e);
  }

  return dedup;
}

export async function upsertCurrentEmployment(
  prisma: PrismaClient,
  args: {
    runId: string;
    personId: string;
    defaultCompanyId?: string | null;
    confidence?: number;
  },
) {
  const facts = await getActivePersonEmploymentFacts(prisma, {
    personId: args.personId,
  });

  const companyId =
    facts.employmentCompanyId?.value ?? args.defaultCompanyId ?? null;
  if (!companyId)
    return { upserted: false as const, employmentId: null as string | null };

  const title = facts.jobTitle?.value ?? null;
  const department = facts.department?.value ?? null;
  const confidence = args.confidence ?? 0.7;

  const activeEmployments = await prisma.employment.findMany({
    where: { personId: args.personId, isCurrent: true },
    orderBy: { lastSeen: "desc" },
    take: 25,
  });

  for (const e of activeEmployments) {
    const sameCompany = e.companyId === companyId;
    const sameTitle = (e.title ?? null) === title;
    const sameDept = (e.department ?? null) === department;
    if (!sameCompany || !sameTitle || !sameDept) {
      await prisma.employment.update({
        where: { id: e.id },
        data: { isCurrent: false, endDate: new Date() },
      });
    }
  }

  const existing = await prisma.employment.findFirst({
    where: {
      personId: args.personId,
      companyId,
      title,
      startDate: null,
    },
    orderBy: { lastSeen: "desc" },
  });

  const employment = existing
    ? await prisma.employment.update({
        where: { id: existing.id },
        data: {
          title,
          department,
          confidence,
          isCurrent: true,
          lastSeen: new Date(),
        },
      })
    : await prisma.employment.create({
        data: {
          personId: args.personId,
          companyId,
          title,
          department,
          seniority: null,
          isCurrent: true,
          startDate: null,
          endDate: null,
          confidence,
        },
      });

  const factIds = [
    facts.employmentCompanyId?.factId,
    facts.jobTitle?.factId,
    facts.department?.factId,
  ].filter(Boolean) as string[];

  const evidence = await getEmploymentEvidenceFromFacts(prisma, { factIds });

  for (const ev of evidence.slice(0, 10)) {
    await prisma.employmentSource
      .create({
        data: {
          employmentId: employment.id,
          source: ev.source,
          url: ev.url ?? null,
          snippet: ev.snippet ?? null,
          observedAt: ev.observedAt,
          runId: ev.runId ?? args.runId,
        },
      })
      .catch(() => null);
  }

  return { upserted: true as const, employmentId: employment.id };
}

export async function reconcilePersonAndProjectEmployment(
  prisma: PrismaClient,
  args: {
    runId: string;
    personId: string;
    companyId?: string | null;
    source?: string | null;
    evidenceUrl?: string | null;
  },
) {
  const reconciled = await reconcilePerson(prisma, {
    runId: args.runId,
    personId: args.personId,
  });
  const signalId = await emitEmployerChangeSignal(prisma, {
    runId: args.runId,
    personId: args.personId,
    source: args.source ?? null,
    evidenceUrl: args.evidenceUrl ?? null,
  });
  const employment = await upsertCurrentEmployment(prisma, {
    runId: args.runId,
    personId: args.personId,
    defaultCompanyId: args.companyId ?? null,
  });

  return { reconciled, signalId, employment };
}

export async function findStaleCurrentEmployments(
  prisma: PrismaClient,
  args: {
    ttlMs: number;
    now?: Date;
    companyId?: string;
    personId?: string;
    limit?: number;
  },
) {
  const now = args.now ?? new Date();
  const cutoff = new Date(now.getTime() - args.ttlMs);

  return prisma.employment.findMany({
    where: {
      isCurrent: true,
      lastSeen: { lt: cutoff },
      ...(args.companyId ? { companyId: args.companyId } : {}),
      ...(args.personId ? { personId: args.personId } : {}),
    },
    orderBy: { lastSeen: "asc" },
    take: args.limit ?? 500,
  });
}

export async function closeEmployment(
  prisma: PrismaClient,
  args: {
    employmentId: string;
    endDate?: Date;
  },
) {
  const endDate = args.endDate ?? new Date();
  return prisma.employment.update({
    where: { id: args.employmentId },
    data: { isCurrent: false, endDate },
  });
}

export async function emitEmploymentCleanupSignal(
  prisma: PrismaClient,
  args: {
    runId: string;
    personId: string;
    companyId?: string | null;
    employmentId: string;
    reason?: string;
  },
) {
  const dedupKey = buildSignalDedupKey({
    entityType: "PERSON",
    entityId: args.personId,
    type: "PERSON_PROFILE_CHANGED",
    field: "employment.cleanup",
    afterNorm: args.employmentId,
  });

  const signal = await prisma.signalEvent.upsert({
    where: { dedupKey },
    update: {
      observedAt: new Date(),
      runId: args.runId,
      reason: args.reason ?? "employment_ttl_expired",
    },
    create: {
      type: "PERSON_PROFILE_CHANGED",
      entityType: "PERSON",
      entityId: args.personId,
      personId: args.personId,
      companyId: args.companyId ?? null,
      field: "employment.cleanup",
      before: args.employmentId,
      beforeNorm: args.employmentId,
      after: null,
      afterNorm: null,
      confidence: 0.6,
      reason: args.reason ?? "employment_ttl_expired",
      source: "ttl",
      evidenceUrl: null,
      observedAt: new Date(),
      runId: args.runId,
      dedupKey,
    },
  });

  return signal.id;
}

export async function cleanupEmploymentsByTTL(
  prisma: PrismaClient,
  args: {
    runId: string;
    ttlMs: number;
    now?: Date;
    companyId?: string;
    personId?: string;
    limit?: number;
    emitSignals?: boolean;
  },
) {
  const now = args.now ?? new Date();
  const stale = await findStaleCurrentEmployments(prisma, {
    ttlMs: args.ttlMs,
    now,
    companyId: args.companyId,
    personId: args.personId,
    limit: args.limit,
  });

  const closedIds: string[] = [];
  const signalIds: string[] = [];

  for (const e of stale) {
    await closeEmployment(prisma, { employmentId: e.id, endDate: now });
    closedIds.push(e.id);

    if (args.emitSignals) {
      const sid = await emitEmploymentCleanupSignal(prisma, {
        runId: args.runId,
        personId: e.personId,
        companyId: e.companyId,
        employmentId: e.id,
      });
      signalIds.push(sid);
    }
  }

  return {
    cutoff: new Date(now.getTime() - args.ttlMs),
    staleCount: stale.length,
    closedIds,
    signalIds,
  };
}
