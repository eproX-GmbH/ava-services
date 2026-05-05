// Gateway-side reconciliation orchestrator for company-contact persist
// events (§8.v3 Phase 3).
//
// The desktop's compute-worker scrapes + LLM-extracts per-page evidence,
// bundles it into a single persist event per (company, source), and
// forwards here. This module:
//
//   1. Builds company-scope observations from the raw extracted fields
//      (emails / phones / addresses / socials) and persists +
//      reconciles them.
//   2. For each detected person, runs the full Person identity-merge,
//      Employment projection, and Signal emission pipeline.
//   3. Optionally runs the cleanup-by-TTL pass when the event is the
//      final one in the dispatch chain.
//
// Reconciliation logic is the original company-contact code vendored
// under `lib/contact-extraction/`; the only edit was repointing
// `PrismaClient` at the gateway-local generated client.

import type { PrismaClient } from "../../generated/company-contact-client";
import { EntityType } from "../../generated/company-contact-client";
import {
  buildPersonObservations,
  emitEmployerChangeSignal,
  persistObservations,
  reconcilePerson,
  upsertPersonByIdentity,
  type EmployeeCandidate,
} from "./contact-extraction/employee-contact";
import {
  cleanupEmploymentsByTTL,
  reconcilePersonAndProjectEmployment,
} from "./contact-extraction/employment";
import { createObservationIdempotent } from "./contact-extraction/observation";
import { reconcileEntity } from "./contact-extraction/reconcile-entity";
import type { ApplyObservationPolicy } from "./contact-extraction/observation";
import type { PersistEvent } from "./persist-bus-types";
import { getContactPrismaClient } from "./contact-prisma";
import type { logger as Logger } from "./logger";

/** Wire shape — what the desktop compute-worker emits per (company,
 *  source) extraction batch. Each top-level field is independently
 *  optional; the apply only does work for fields that are present. */
export interface CompanyContactPersistRequest {
  runId: string;
  tenantId: string;
  dispatchedAt: string;
  computedAt: string;
  result: {
    companyId: string;
    /** "agent:website" | "agent:website_people" | "search" | … */
    source: string;
    evidenceUrl: string | null;
    defaultCountryCode?: string;
    /** Company-level facts extracted from a website-contact page or
     *  search result. Each list is independently optional and gets
     *  expanded into individual Observation rows. */
    companyExtracts?: {
      emails?: string[];
      phones?: string[];
      addresses?: string[];
      /** Social profile links keyed by platform slug. */
      socials?: { platform?: string; url: string }[];
    };
    /** Person candidates from the website-people agent or SERP
     *  extract. Each becomes one upsert + observation set + reconcile
     *  + signal emission. */
    people?: Array<{
      fullName: string;
      title?: string;
      department?: string;
      linkedinUrl?: string;
      xingUrl?: string;
      email?: string;
      phone?: string;
      sourceUrl?: string | null;
    }>;
    /** When set, run cleanupEmploymentsByTTL after processing. The
     *  compute-worker emits this on the LAST event of a dispatch
     *  chain so we don't TTL-cleanup mid-pipeline (which would
     *  spuriously close employments the next event was about to
     *  reconfirm). */
    cleanupTtlMs?: number;
  };
}

type Log = typeof Logger;

/** Single-entry orchestrator the persist-bus calls. */
export async function applyCompanyContactPersist(
  data: PersistEvent<CompanyContactPersistRequest["result"]>,
  log: Log,
): Promise<void> {
  const { result, runId, tenantId } = data;
  if (!result?.companyId) throw new Error("missing result.companyId");
  if (!result.source) throw new Error("missing result.source");

  const prisma = getContactPrismaClient();
  const companyId = result.companyId;
  const evidenceUrl = result.evidenceUrl ?? null;
  const source = result.source;

  // Ensure the parent Company row exists. The reconciliation logic
  // inside `reconcileEntity` relies on the Company FK being valid.
  await prisma.company.upsert({
    where: { id: companyId },
    update: {},
    create: { id: companyId },
  });

  let observationsCreated = 0;

  // Mirrors the policy the legacy `runWebsiteContactAgent` used —
  // company contact fields are change-tracked (a new observed value
  // replaces the prior fact), and adding a new email/phone/address
  // marks the prior one inactive (single-source-of-truth per field).
  const COMPANY_POLICY: ApplyObservationPolicy = {
    multiValueFields: new Set<string>([]),
    changeFields: new Set<string>(["phone", "email", "address", "websiteUrl"]),
    inactiveOnNewForFields: new Set<string>(["phone", "email", "address"]),
  };

  // ---- 1. Company-scope facts ----------------------------------------------
  if (result.companyExtracts) {
    const ce = result.companyExtracts;
    const companyObs: Array<{
      field: string;
      value: string;
    }> = [
      ...(ce.emails ?? []).map((v) => ({ field: "email", value: v })),
      ...(ce.phones ?? []).map((v) => ({ field: "phone", value: v })),
      ...(ce.addresses ?? []).map((v) => ({ field: "address", value: v })),
      ...(ce.socials ?? []).map((s) => ({
        field: `social:${(s.platform ?? "unknown").toLowerCase()}`,
        value: s.url,
      })),
    ];

    for (const o of companyObs) {
      const created = await createObservationIdempotent(prisma, {
        entityType: EntityType.COMPANY,
        entityId: companyId,
        companyId,
        field: o.field,
        value: o.value,
        source,
        evidenceUrl,
        evidence: null,
        runId,
        defaultCountryCode: result.defaultCountryCode,
      });
      if (created?.id) observationsCreated += 1;
    }

    if (companyObs.length > 0) {
      await reconcileEntity(prisma, {
        entityType: EntityType.COMPANY,
        entityId: companyId,
        companyId,
        runId,
        observedAfter: null,
        policy: COMPANY_POLICY,
      });
    }
  }

  // ---- 2. Per-person upsert + reconciliation -------------------------------
  let personsTouched = 0;
  for (const p of result.people ?? []) {
    const candidate: EmployeeCandidate = {
      fullName: p.fullName,
      title: p.title,
      department: p.department,
      linkedinUrl: p.linkedinUrl,
      xingUrl: p.xingUrl,
      email: p.email,
      phone: p.phone,
      source: source,
      sourceUrl: p.sourceUrl ?? evidenceUrl ?? undefined,
    };
    const up = await upsertPersonByIdentity(prisma, { companyId, candidate });
    const obs = buildPersonObservations({
      personId: up.personId,
      identityKey: up.identityKey,
      companyId,
      candidate: p,
      source,
      evidenceUrl: evidenceUrl ?? undefined,
      defaultCountryCode: result.defaultCountryCode,
    });
    await persistObservations(prisma, { runId, observations: obs });
    await reconcilePerson(prisma, {
      runId,
      personId: up.personId,
    });
    await reconcilePersonAndProjectEmployment(prisma, {
      runId,
      personId: up.personId,
      companyId,
      source,
      evidenceUrl: evidenceUrl ?? undefined,
    });
    await emitEmployerChangeSignal(prisma, {
      runId,
      personId: up.personId,
      source,
      evidenceUrl: evidenceUrl ?? undefined,
    });
    personsTouched += 1;
  }

  // ---- 3. Optional TTL cleanup (last event in chain) -----------------------
  if (typeof result.cleanupTtlMs === "number" && result.cleanupTtlMs > 0) {
    await cleanupEmploymentsByTTL(prisma, {
      runId,
      ttlMs: result.cleanupTtlMs,
      companyId,
      emitSignals: true,
    });
  }

  log.info(
    {
      runId,
      tenantId,
      companyId,
      source,
      observationsCreated,
      personsTouched,
      ttlCleanup: result.cleanupTtlMs ?? null,
    },
    "company-contact persist ✓",
  );
}
