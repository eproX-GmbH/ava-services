// Register-Verlauf (Burggraben 1, docs/PLAN_BURGGRABEN.md).
//
// Der structured-content-Persist ueberschreibt den Registerstand einer Firma
// (StructuredContent + ManagingDirector per Replace-All). ProfileChangeEvent
// haelt davon nur den Diff einzelner Felder fest. Hier bleibt zusaetzlich der
// ganze ALTE Stand als Zeile liegen, sobald sich irgendein Feld geaendert hat:
// Kapital, Sitz, Gegenstand, Rechtsform, Name, Gruendungsjahr, Registerdaten,
// Geschaeftsfuehrung. Die Zeitachse einer Firma = Snapshots + lebende Zeile.
//
// Eigenschaften:
//   * Tabelle RegisterSnapshot in der Gateway-DB (Prisma-Migration 20261112).
//   * Schreiben ist best-effort NACH dem COMMIT des Persists; ein Fehler hier
//     bricht den Persist nie.
//   * Ein erneuter Abruf ohne Aenderung erzeugt keine Zeile (sonst wuerde
//     jede Auffrischung die Tabelle fuellen).
//   * Erstbefuellung (kein Altbestand) erzeugt keine Zeile.
//   * Nie loeschen: Beobachtungen lassen sich nicht nachtraeglich scrapen.

import type { Logger } from "pino";
import { getGatewayPool } from "./producer-pools";

export interface RegisterPerson {
  firstName: string;
  lastName: string;
  birthDay?: string | null;
  city?: string | null;
  bestelltAm?: string | null;
}

/** Vollstaendiger Registerstand, wie er in StructuredContent + ManagingDirector liegt. */
export interface RegisterStand {
  name: string | null;
  legalForm: string | null;
  street: string | null;
  houseNumber: string | null;
  zipCode: string | null;
  city: string | null;
  foundingYear: number | null;
  corporatePurpose: string | null;
  shareCapital: string | null;
  lastRegisterEntry: string | null;
  lastRegisterModification: string | null;
  geschaeftsfuehrung: RegisterPerson[];
}

export type RegisterFeld =
  | "name"
  | "legalForm"
  | "address"
  | "foundingYear"
  | "corporatePurpose"
  | "shareCapital"
  | "lastRegisterEntry"
  | "lastRegisterModification"
  | "geschaeftsfuehrung";

const norm = (v: unknown): string => (v == null ? "" : String(v).replace(/\s+/g, " ").trim().toLowerCase());
const datum = (v: unknown): string => {
  if (v == null || v === "") return "";
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? norm(v) : d.toISOString().slice(0, 10);
};
const zahl = (v: unknown): string => {
  if (v == null || v === "") return "";
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : norm(v);
};
const personen = (p: RegisterPerson[]): string =>
  p
    .map((x) => `${norm(x.firstName)} ${norm(x.lastName)}`.trim())
    .filter(Boolean)
    .sort()
    .join("|");

/**
 * Welche Felder weichen zwischen altem und neuem Stand ab? Leer = kein Snapshot.
 * Verglichen wird normalisiert (Leerraum, Gross/Klein, Zahlen, Datum); die
 * Geschaeftsfuehrung als Namensmenge (wie diffManagingDirectors), nicht nach
 * Geburtsdatum oder Wohnort.
 */
export function registerStandFelder(alt: RegisterStand, neu: RegisterStand): RegisterFeld[] {
  const out: RegisterFeld[] = [];
  const adresse = (x: RegisterStand): string => norm(`${norm(x.street)} ${norm(x.houseNumber)}, ${norm(x.zipCode)} ${norm(x.city)}`);
  if (norm(alt.name) !== norm(neu.name)) out.push("name");
  if (norm(alt.legalForm) !== norm(neu.legalForm)) out.push("legalForm");
  if (adresse(alt) !== adresse(neu)) out.push("address");
  if (zahl(alt.foundingYear) !== zahl(neu.foundingYear)) out.push("foundingYear");
  if (norm(alt.corporatePurpose) !== norm(neu.corporatePurpose)) out.push("corporatePurpose");
  if (zahl(alt.shareCapital) !== zahl(neu.shareCapital)) out.push("shareCapital");
  if (datum(alt.lastRegisterEntry) !== datum(neu.lastRegisterEntry)) out.push("lastRegisterEntry");
  if (datum(alt.lastRegisterModification) !== datum(neu.lastRegisterModification)) out.push("lastRegisterModification");
  if (personen(alt.geschaeftsfuehrung) !== personen(neu.geschaeftsfuehrung)) out.push("geschaeftsfuehrung");
  return out;
}

export interface SnapshotEingang {
  companyId: string;
  quelle: string;
  stand: RegisterStand;
  felder: RegisterFeld[];
  /** updatedAt des alten Stands (letzte Bestaetigung). */
  bestandVon: Date | null;
  /** computedAt des neuen Stands, der ihn ersetzt. */
  ersetztAm: Date;
  runId: string | null;
}

/** Alten Stand ablegen. Best-effort: loggt, wirft nie. */
export async function schreibeRegisterSnapshot(log: Logger, e: SnapshotEingang): Promise<void> {
  if (e.felder.length === 0) return;
  try {
    await getGatewayPool().query(
      `INSERT INTO "RegisterSnapshot" ("companyId", quelle, stand, felder, "bestandVon", "ersetztAm", "runId")
       VALUES ($1, $2, $3::jsonb, $4::text[], $5, $6, $7)`,
      [e.companyId, e.quelle, JSON.stringify(e.stand), e.felder, e.bestandVon, e.ersetztAm, e.runId],
    );
    log.info({ companyId: e.companyId, felder: e.felder }, "register-snapshot abgelegt");
  } catch (err) {
    log.warn({ err, companyId: e.companyId }, "register-snapshot fehlgeschlagen (best-effort, Persist unberuehrt)");
  }
}

export interface RegisterSnapshotZeile {
  id: string;
  companyId: string;
  quelle: string;
  felder: string[];
  bestandVon: string | null;
  ersetztAm: string;
  stand: RegisterStand;
}

/** Verlauf einer Firma, juengster Snapshot zuerst (die lebende Zeile ist der aktuelle Stand). */
export async function listeRegisterVerlauf(companyId: string, limit = 50): Promise<RegisterSnapshotZeile[]> {
  const r = await getGatewayPool().query<{
    id: string; companyId: string; quelle: string; felder: string[]; bestandVon: Date | null; ersetztAm: Date; stand: RegisterStand;
  }>(
    `SELECT id::text, "companyId", quelle, felder, "bestandVon", "ersetztAm", stand
       FROM "RegisterSnapshot"
      WHERE "companyId" = $1
      ORDER BY "ersetztAm" DESC, id DESC
      LIMIT $2`,
    [companyId, Math.max(1, Math.min(500, limit))],
  );
  return r.rows.map((z) => ({
    id: z.id,
    companyId: z.companyId,
    quelle: z.quelle,
    felder: Array.isArray(z.felder) ? z.felder : [],
    bestandVon: z.bestandVon ? new Date(z.bestandVon).toISOString() : null,
    ersetztAm: new Date(z.ersetztAm).toISOString(),
    stand: z.stand,
  }));
}
