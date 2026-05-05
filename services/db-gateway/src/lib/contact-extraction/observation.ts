import type { PrismaClient, EntityType, FactStatus } from "../../../generated/company-contact-client";
import { normalizeValue } from "./normalize-value";
import { buildObservationHash, buildSignalDedupKey } from "./hashing";

export type CreateObservationInput = {
  entityType: EntityType;
  entityId: string;
  companyId?: string | null;
  personId?: string | null;
  field: string;
  value: string;
  source: string;
  evidenceUrl?: string | null;
  evidence?: string | null;
  runId?: string | null;
  defaultCountryCode?: string;
  observedAt?: Date;
};

export async function createObservationIdempotent(
  prisma: PrismaClient,
  input: CreateObservationInput,
) {
  const normalized = normalizeValue({
    field: input.field,
    value: input.value,
    defaultCountryCode: input.defaultCountryCode,
  });

  const hash = buildObservationHash({
    entityType: input.entityType,
    entityId: input.entityId,
    field: input.field,
    normalized,
    source: input.source,
    evidenceUrl: input.evidenceUrl ?? null,
  });

  const observedAt = input.observedAt ?? new Date();

  return await prisma.observation.upsert({
    where: { hash },
    update: {
      evidence: input.evidence ?? undefined,
      evidenceUrl: input.evidenceUrl ?? undefined,
      observedAt,
      runId: input.runId ?? undefined,
    },
    create: {
      entityType: input.entityType,
      entityId: input.entityId,
      companyId: input.companyId ?? null,
      personId: input.personId ?? null,
      field: input.field,
      value: input.value,
      normalized,
      source: input.source,
      evidenceUrl: input.evidenceUrl ?? null,
      evidence: input.evidence ?? null,
      observedAt,
      runId: input.runId ?? null,
      hash,
    },
  });
}

export type ApplyObservationPolicy = {
  multiValueFields?: Set<string>;
  changeFields?: Set<string>;
  inactiveOnNewForFields?: Set<string>;
};

export type ApplyObservationResult = {
  factId: string;
  createdFact: boolean;
  emittedSignalIds: string[];
};

export async function applyObservation(
  prisma: PrismaClient,
  args: {
    observationId: string;
    entityType: EntityType;
    entityId: string;
    companyId?: string | null;
    personId?: string | null;
    field: string;
    value: string;
    normalized: string;
    source: string;
    evidenceUrl?: string | null;
    runId?: string | null;
    observedAt?: Date;
    policy: ApplyObservationPolicy;
  },
): Promise<ApplyObservationResult> {
  const observedAt = args.observedAt ?? new Date();

  const existingFact = await prisma.fact.findFirst({
    where: {
      entityType: args.entityType,
      entityId: args.entityId,
      field: args.field,
      normalized: args.normalized,
    },
  });

  const multiValue = args.policy.multiValueFields?.has(args.field) ?? false;
  const inactiveOnNew =
    args.policy.inactiveOnNewForFields?.has(args.field) ?? false;
  const isChangeField = args.policy.changeFields?.has(args.field) ?? false;

  let fact = existingFact;
  let createdFact = false;
  const emittedSignalIds: string[] = [];

  if (!fact) {
    fact = await prisma.fact.create({
      data: {
        entityType: args.entityType,
        entityId: args.entityId,
        field: args.field,
        value: args.value,
        normalized: args.normalized,
        status: "ACTIVE",
        confidence: 0.6,
        lastObsId: args.observationId,
        companyId: args.companyId ?? null,
        personId: args.personId ?? null,
      },
    });
    createdFact = true;
  } else {
    fact = await prisma.fact.update({
      where: { id: fact.id },
      data: {
        value: args.value,
        lastObsId: args.observationId,
        status: "ACTIVE",
        lastSeen: observedAt,
      },
    });
  }

  await prisma.factObservationLink.upsert({
    where: {
      factId_observationId: {
        factId: fact.id,
        observationId: args.observationId,
      },
    },
    update: {},
    create: { factId: fact.id, observationId: args.observationId },
  });

  if (createdFact) {
    const type =
      args.entityType === "COMPANY"
        ? args.field.toLowerCase().includes("phone")
          ? "COMPANY_PHONE_ADDED"
          : args.field.toLowerCase().includes("email")
            ? "COMPANY_EMAIL_ADDED"
            : args.field.toLowerCase().includes("social") ||
                args.field.toLowerCase().includes("linkedin")
              ? "COMPANY_SOCIAL_ADDED"
              : "FACT_RECONFIRMED"
        : args.field.toLowerCase().includes("phone")
          ? "PERSON_PHONE_ADDED"
          : args.field.toLowerCase().includes("email")
            ? "PERSON_EMAIL_ADDED"
            : "FACT_RECONFIRMED";

    if (type !== "FACT_RECONFIRMED") {
      const dedupKey = buildSignalDedupKey({
        entityType: args.entityType,
        entityId: args.entityId,
        type,
        field: args.field,
        afterNorm: args.normalized,
      });

      const signal = await prisma.signalEvent.upsert({
        where: { dedupKey },
        update: {
          observedAt,
          runId: args.runId ?? undefined,
          source: args.source,
          evidenceUrl: args.evidenceUrl ?? undefined,
          after: args.value,
          afterNorm: args.normalized,
          entityType: args.entityType,
          entityId: args.entityId,
          field: args.field,
          companyId: args.companyId ?? null,
          personId: args.personId ?? null,
        },
        create: {
          type: type as any,
          entityType: args.entityType,
          entityId: args.entityId,
          field: args.field,
          after: args.value,
          afterNorm: args.normalized,
          confidence: 0.7,
          reason: "new_fact_observed",
          source: args.source,
          evidenceUrl: args.evidenceUrl ?? null,
          observedAt,
          runId: args.runId ?? null,
          dedupKey,
          companyId: args.companyId ?? null,
          personId: args.personId ?? null,
        },
      });

      await prisma.factSignalLink.upsert({
        where: { factId_signalId: { factId: fact.id, signalId: signal.id } },
        update: {},
        create: { factId: fact.id, signalId: signal.id },
      });

      emittedSignalIds.push(signal.id);
    }
  }

  if (!multiValue && inactiveOnNew) {
    await prisma.fact.updateMany({
      where: {
        entityType: args.entityType,
        entityId: args.entityId,
        field: args.field,
        id: { not: fact.id },
        status: "ACTIVE",
      },
      data: { status: "INACTIVE" as FactStatus },
    });

    if (isChangeField) {
      const previousActive = await prisma.fact.findFirst({
        where: {
          entityType: args.entityType,
          entityId: args.entityId,
          field: args.field,
          id: { not: fact.id },
        },
        orderBy: { lastSeen: "desc" },
      });

      if (previousActive) {
        const type =
          args.entityType === "COMPANY"
            ? args.field.toLowerCase().includes("phone")
              ? "COMPANY_PHONE_CHANGED"
              : args.field.toLowerCase().includes("email")
                ? "COMPANY_EMAIL_CHANGED"
                : "FACT_RECONFIRMED"
            : args.field.toLowerCase().includes("job") ||
                args.field.toLowerCase().includes("title")
              ? "PERSON_JOB_CHANGED"
              : "FACT_RECONFIRMED";

        if (type !== "FACT_RECONFIRMED") {
          const dedupKey = buildSignalDedupKey({
            entityType: args.entityType,
            entityId: args.entityId,
            type,
            field: args.field,
            afterNorm: args.normalized,
          });

          const signal = await prisma.signalEvent.upsert({
            where: { dedupKey },
            update: {
              observedAt,
              runId: args.runId ?? undefined,
              source: args.source,
              evidenceUrl: args.evidenceUrl ?? undefined,
              before: previousActive.value,
              beforeNorm: previousActive.normalized,
              after: args.value,
              afterNorm: args.normalized,
            },
            create: {
              type: type as any,
              entityType: args.entityType,
              entityId: args.entityId,
              field: args.field,
              before: previousActive.value,
              beforeNorm: previousActive.normalized,
              after: args.value,
              afterNorm: args.normalized,
              confidence: 0.75,
              reason: "field_replaced",
              source: args.source,
              evidenceUrl: args.evidenceUrl ?? null,
              observedAt,
              runId: args.runId ?? null,
              dedupKey,
              companyId: args.companyId ?? null,
              personId: args.personId ?? null,
            },
          });

          await prisma.factSignalLink.upsert({
            where: {
              factId_signalId: { factId: fact.id, signalId: signal.id },
            },
            update: {},
            create: { factId: fact.id, signalId: signal.id },
          });

          emittedSignalIds.push(signal.id);
        }
      }
    }
  }

  return { factId: fact.id, createdFact, emittedSignalIds };
}
