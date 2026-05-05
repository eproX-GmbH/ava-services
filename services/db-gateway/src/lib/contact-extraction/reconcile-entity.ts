import type { PrismaClient, EntityType } from "../../../generated/company-contact-client";
import { applyObservation, ApplyObservationPolicy } from "./observation";

export type ReconcileEntityInput = {
  entityType: EntityType;
  entityId: string;
  companyId?: string | null;
  personId?: string | null;
  runId?: string | null;
  observedAfter?: Date | null;
  policy: ApplyObservationPolicy;
};

export async function reconcileEntity(
  prisma: PrismaClient,
  input: ReconcileEntityInput,
) {
  const observations = await prisma.observation.findMany({
    where: {
      entityType: input.entityType,
      entityId: input.entityId,
      observedAt: input.observedAfter ? { gt: input.observedAfter } : undefined,
      runId: input.runId ?? undefined,
    },
    orderBy: { observedAt: "asc" },
  });

  const results = [];
  for (const o of observations) {
    const r = await applyObservation(prisma, {
      observationId: o.id,
      entityType: o.entityType,
      entityId: o.entityId,
      companyId: input.companyId ?? o.companyId ?? null,
      personId: input.personId ?? o.personId ?? null,
      field: o.field,
      value: o.value,
      normalized: o.normalized,
      source: o.source,
      evidenceUrl: o.evidenceUrl,
      runId: o.runId ?? input.runId ?? null,
      observedAt: o.observedAt,
      policy: input.policy,
    });
    results.push({ observationId: o.id, ...r });
  }

  return { processed: observations.length, results };
}
