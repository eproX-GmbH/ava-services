import type { PrismaClient, EntityType, FactStatus } from "../../../generated/company-contact-client";
import { normalizeValue } from "./normalize-value";
import { cleanContactValueForDisplay } from "./presentation";
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
  // Nadeloehr fuer ALLE drei Extraktions-Quellen: erst den Wert fuer
  // die Anzeige bereinigen (De-Obfuskierung, tel://-Praefixe, Labels),
  // dann daraus die Dedup-Normalform berechnen. Vorher landeten
  // Rohwerte wie "info (at) quikk.de" unveraendert in Fact.value UND
  // in der Normalform — kein Dedup gegen "info@quikk.de".
  const cleanedValue = cleanContactValueForDisplay({
    field: input.field,
    value: input.value,
  });
  const normalized = normalizeValue({
    field: input.field,
    value: cleanedValue,
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
      value: cleanedValue,
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

  // Konfidenz aus der Beleglage berechnen — vorher stand hier eine
  // Konstante (0.6, nie aktualisiert): jeder Balken zeigte 60 %,
  // egal ob ein Einmal-Fund oder fuenffach bestaetigt.
  //
  // Formel (bewusst simpel und erklaerbar):
  //   0.45 + 0.15 * min(#unterschiedliche Beleg-URLs, 3)
  //        + 0.05 * min(#unterschiedliche Quellen - 1, 2), Cap 0.95
  // → 1 Beleg = 0.60 (Kontinuitaet zum alten Wert), 2 URLs = 0.75,
  //   3+ URLs = 0.90, unabhaengige Quellen (website/people/search)
  //   geben den Rest bis 0.95.
  const links = await prisma.factObservationLink.findMany({
    where: { factId: fact.id },
    include: { observation: { select: { evidenceUrl: true, source: true } } },
  });
  const evidenceUrls = new Set(
    links.map((l) => l.observation.evidenceUrl ?? "(ohne-url)"),
  );
  const sources = new Set(links.map((l) => l.observation.source));
  const confidence = Math.min(
    0.95,
    0.45 +
      0.15 * Math.min(evidenceUrls.size, 3) +
      0.05 * Math.min(Math.max(sources.size - 1, 0), 2),
  );
  if (Math.abs(confidence - fact.confidence) > 0.001) {
    fact = await prisma.fact.update({
      where: { id: fact.id },
      data: { confidence },
    });
  }

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
