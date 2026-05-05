import type { PrismaClient, EntityType } from "../../../generated/company-contact-client";
import { buildSignalDedupKey } from "./hashing";

export async function emitRemovalsByTTL(
  prisma: PrismaClient,
  args: {
    entityType: EntityType;
    entityId: string;
    companyId?: string | null;
    personId?: string | null;
    field: string;
    ttlMs: number;
    now?: Date;
    runId?: string | null;
    source?: string | null;
  },
) {
  const now = args.now ?? new Date();
  const cutoff = new Date(now.getTime() - args.ttlMs);

  const staleFacts = await prisma.fact.findMany({
    where: {
      entityType: args.entityType,
      entityId: args.entityId,
      field: args.field,
      status: "ACTIVE",
      lastSeen: { lt: cutoff },
    },
  });

  const emitted: string[] = [];

  for (const f of staleFacts) {
    const type =
      args.entityType === "COMPANY"
        ? args.field.toLowerCase().includes("phone")
          ? "COMPANY_PHONE_REMOVED"
          : args.field.toLowerCase().includes("email")
            ? "COMPANY_EMAIL_REMOVED"
            : args.field.toLowerCase().includes("social") ||
                args.field.toLowerCase().includes("linkedin")
              ? "COMPANY_SOCIAL_REMOVED"
              : "FACT_RECONFIRMED"
        : args.field.toLowerCase().includes("phone")
          ? "PERSON_PHONE_REMOVED"
          : args.field.toLowerCase().includes("email")
            ? "PERSON_EMAIL_REMOVED"
            : "FACT_RECONFIRMED";

    if (type === "FACT_RECONFIRMED") continue;

    const dedupKey = buildSignalDedupKey({
      entityType: args.entityType,
      entityId: args.entityId,
      type,
      field: args.field,
      afterNorm: f.normalized,
    });

    const signal = await prisma.signalEvent.upsert({
      where: { dedupKey },
      update: { observedAt: now, runId: args.runId ?? undefined },
      create: {
        type: type as any,
        entityType: args.entityType,
        entityId: args.entityId,
        field: args.field,
        before: f.value,
        beforeNorm: f.normalized,
        after: null,
        afterNorm: null,
        confidence: 0.65,
        reason: "ttl_expired",
        source: args.source ?? "ttl",
        evidenceUrl: null,
        observedAt: now,
        runId: args.runId ?? null,
        dedupKey,
        companyId: args.companyId ?? null,
        personId: args.personId ?? null,
      },
    });

    await prisma.factSignalLink.upsert({
      where: { factId_signalId: { factId: f.id, signalId: signal.id } },
      update: {},
      create: { factId: f.id, signalId: signal.id },
    });

    await prisma.fact.update({
      where: { id: f.id },
      data: { status: "INACTIVE" },
    });
    emitted.push(signal.id);
  }

  return { markedInactive: staleFacts.length, emitted };
}
