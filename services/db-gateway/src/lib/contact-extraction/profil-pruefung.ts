// Oeffentliche LinkedIn-Profile lokal gelesen (Vorschlag Patrick 2026-11-02,
// Entscheidung Joyce 2026-11-03): Der Kontakt-Producer liest beim 14-Tage-Lauf
// die bekannten Profiladressen der Firma im Hintergrund-Chrome des Nutzers
// (JSON-LD + Meta-Text, ohne Anmeldung) und meldet je Person ein Ergebnis:
//
//   bestaetigt     Arbeitgeber laut Profil = diese Firma → Position/Beschaeftigung
//                  wie ein Website-Fund bestaetigen (voller Kandidaten-Pfad).
//   gewechselt     Arbeitgeber laut Profil ist eine andere Firma → Beschaeftigung
//                  schliessen, Fakt deaktivieren, Signal PERSON_EMPLOYER_CHANGED
//                  (erscheint als Meldung "Arbeitgeberwechsel" mit Fundstelle).
//   gesperrt       LinkedIn hat die Anmeldewand gezeigt → nur vermerken.
//   nicht_gefunden Profil weg oder Name passt nicht → nur vermerken.
//
// Jede Pruefung hinterlaesst eine Beobachtung `linkedin:pruefung` an der Person,
// damit der Producer beim naechsten Lauf weiss, wen er zuletzt wann geprueft hat,
// und die Einstellungen eine Statistik zeigen koennen.

import type { PrismaClient } from "../../../generated/company-contact-client";
import { EntityType } from "../../../generated/company-contact-client";
import { createObservationIdempotent } from "./observation";
import { buildSignalDedupKey } from "./hashing";
import { closeEmployment } from "./employment";
import type { logger as Logger } from "../logger";

export const PRUEFUNG_FELD = "linkedin:pruefung";
export const ARBEITGEBER_FELD = "linkedin:arbeitgeber";

export type ProfilPruefungErgebnis = "bestaetigt" | "gewechselt" | "gesperrt" | "nicht_gefunden";

export interface ProfilPruefung {
  personId?: string;
  linkedinUrl: string;
  fullName?: string;
  ergebnis: ProfilPruefungErgebnis;
  /** Arbeitgeber laut Profil (bei bestaetigt/gewechselt). */
  arbeitgeber?: string;
  /** Position laut Profil, falls lesbar. */
  titel?: string;
  evidenceUrl?: string | null;
  /** linkedin:oeffentlich | apify:profil */
  quelle?: string;
}

function datumKurz(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Person zur Pruefung finden: ueber personId oder ueber den linkedinUrl-Fakt. */
export async function findePerson(prisma: PrismaClient, companyId: string, p: ProfilPruefung): Promise<{ id: string; fullName: string | null } | null> {
  if (p.personId) {
    const person = await prisma.person.findUnique({ where: { id: p.personId }, select: { id: true, fullName: true } });
    if (person) return person;
  }
  const norm = p.linkedinUrl.trim().toLowerCase().replace(/\/+$/, "");
  const fact = await prisma.fact.findFirst({
    where: { entityType: EntityType.PERSON, field: "linkedinUrl", normalized: norm, status: "ACTIVE" },
    select: { entityId: true },
  });
  if (!fact) return null;
  const emp = await prisma.employment.findFirst({ where: { personId: fact.entityId, companyId, isCurrent: true }, select: { personId: true } });
  if (!emp) return null;
  return prisma.person.findUnique({ where: { id: fact.entityId }, select: { id: true, fullName: true } });
}

/** Vermerk je Pruefung (jedes Ergebnis). */
export async function pruefungVermerken(
  prisma: PrismaClient,
  args: { runId: string; personId: string; companyId: string; p: ProfilPruefung; am: Date },
): Promise<void> {
  const { p } = args;
  const wert = `${p.ergebnis} ${datumKurz(args.am)}${p.arbeitgeber ? ` · ${p.arbeitgeber}` : ""}`;
  await createObservationIdempotent(prisma, {
    entityType: EntityType.PERSON,
    entityId: args.personId,
    personId: args.personId,
    companyId: args.companyId,
    field: PRUEFUNG_FELD,
    value: wert.slice(0, 200),
    source: p.quelle ?? "linkedin:oeffentlich",
    evidenceUrl: p.evidenceUrl ?? p.linkedinUrl,
    runId: args.runId,
    observedAt: args.am,
  });
}

/**
 * Arbeitgeberwechsel verbuchen: Beschaeftigung bei dieser Firma schliessen,
 * Fakt employmentCompanyId deaktivieren, Beobachtungen alter/neuer Arbeitgeber,
 * Signal PERSON_EMPLOYER_CHANGED (Meldung "Arbeitgeberwechsel").
 */
export async function wechselVerbuchen(
  prisma: PrismaClient,
  log: typeof Logger,
  args: { runId: string; personId: string; companyId: string; companyName: string | null; p: ProfilPruefung; am: Date },
): Promise<void> {
  const { p, personId, companyId, am } = args;
  const neu = (p.arbeitgeber ?? "").trim();
  if (!neu) return;
  const quelle = p.quelle ?? "linkedin:oeffentlich";
  const evidenceUrl = p.evidenceUrl ?? p.linkedinUrl;
  const alt = args.companyName?.trim() || companyId;

  const emps = await prisma.employment.findMany({ where: { personId, companyId, isCurrent: true } });
  for (const e of emps) await closeEmployment(prisma, { employmentId: e.id, endDate: am });

  // Alter Stand als Beobachtung mit dem Zeitpunkt der letzten Bestaetigung: so
  // sieht die Meldungs-Logik (alter Wert zuletzt VOR dem Signal gesehen, neuer
  // Wert danach erstmals) einen echten Uebergang.
  const zuletzt = emps.reduce<Date | null>((m, e) => (e.lastSeen && (!m || e.lastSeen > m) ? e.lastSeen : m), null) ?? new Date(am.getTime() - 86_400_000);
  await createObservationIdempotent(prisma, {
    entityType: EntityType.PERSON, entityId: personId, personId, companyId,
    field: ARBEITGEBER_FELD, value: alt, source: "ava:beschaeftigung",
    evidenceUrl: null, evidence: `Beschäftigung bei AVA zuletzt bestätigt am ${datumKurz(zuletzt)}`,
    runId: args.runId, observedAt: zuletzt,
  });
  await createObservationIdempotent(prisma, {
    entityType: EntityType.PERSON, entityId: personId, personId, companyId,
    field: ARBEITGEBER_FELD, value: neu, source: quelle, evidenceUrl, runId: args.runId, observedAt: am,
  });

  await prisma.fact.updateMany({
    where: { entityType: EntityType.PERSON, entityId: personId, field: "employmentCompanyId", value: companyId, status: "ACTIVE" },
    data: { status: "INACTIVE", deactivatedAt: am, deactivatedReason: "linkedin_profil_anderer_arbeitgeber" },
  });

  const dedupKey = buildSignalDedupKey({ entityType: "PERSON", entityId: personId, type: "PERSON_EMPLOYER_CHANGED", field: ARBEITGEBER_FELD, afterNorm: neu.toLowerCase(), scopeCompanyId: companyId });
  await prisma.signalEvent.upsert({
    where: { dedupKey },
    update: { observedAt: am, runId: args.runId, source: quelle, evidenceUrl, before: alt, after: neu, afterNorm: neu.toLowerCase() },
    create: {
      type: "PERSON_EMPLOYER_CHANGED", entityType: EntityType.PERSON, entityId: personId, personId, companyId,
      field: ARBEITGEBER_FELD, before: alt, beforeNorm: alt.toLowerCase(), after: neu, afterNorm: neu.toLowerCase(),
      confidence: 0.8, reason: "linkedin_profil_anderer_arbeitgeber", source: quelle, evidenceUrl, observedAt: am, runId: args.runId, dedupKey,
    },
  });
  log.info({ runId: args.runId, companyId, personId, von: alt, nach: neu, quelle }, "profil-pruefung: Arbeitgeberwechsel verbucht");
}
