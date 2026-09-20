// C1 (docs/PLAN_COMPLIANCE_ENTERPRISE.md §1) — Audit-Trail zu Personen.
//
//   - Observation.tenantId/actorId (nachtraegliche Spalten, Backfill NULL):
//     wer hat wann was erhoben. Gesetzt nach jedem Persist.
//   - Herkunftsnachweis je Person (Art. 15): alle Fakten mit Quelle, Beleg,
//     Zeitpunkt, erhebendem Tenant — JSON und Markdown.
//   - Personen-Tombstone: Loeschung im geteilten Bestand (global,
//     Entscheidung 2026-09-03) + Sperre gegen Wiedererfassung ueber
//     Identitaets-Schluessel (Profil-URL) und Namens-Hash.
//   - „Informiert am" (Art. 14) je Tenant und Person.
//   - Aufbewahrung: Person ohne Beobachtung seit N Tagen tilgen (Standard
//     180, je Tenant einstellbar; bei mehreren Tenants gilt der kleinste Wert).
//
// Schema-Aenderungen an der Kontakt-DB laufen als IF-NOT-EXISTS-DDL aus dem
// Gateway (die Prisma-Migrationen des Producers werden seit der
// Lokalisierung nicht mehr ueber CI ausgerollt); der generierte Prisma-
// Client bleibt unveraendert, die neuen Spalten werden per SQL gelesen.

import { createHash } from "node:crypto";
import type pg from "pg";
import { nameIdentityForm } from "./contact-extraction/sanitize-person";
import { normalizeLinkedInProfileUrl } from "./contact-extraction/employee-contact";
import { logger } from "./logger";

export const DEFAULT_PERSON_RETENTION_DAYS = 180;

let schemaReady = false;
export async function ensurePersonComplianceSchema(pool: pg.Pool): Promise<void> {
  if (schemaReady) return;
  await pool.query(`ALTER TABLE "Observation" ADD COLUMN IF NOT EXISTS "tenantId" TEXT`);
  await pool.query(`ALTER TABLE "Observation" ADD COLUMN IF NOT EXISTS "actorId" TEXT`);
  await pool.query(`CREATE INDEX IF NOT EXISTS "Observation_tenantId_idx" ON "Observation"("tenantId")`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "PersonTombstone" (
      "hash"      TEXT PRIMARY KEY,
      "kind"      TEXT NOT NULL,
      "personId"  TEXT,
      "fullName"  TEXT,
      "tenantId"  TEXT,
      "deletedBy" TEXT,
      "reason"    TEXT,
      "deletedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "PersonNotice" (
      "tenantId"   TEXT NOT NULL,
      "personId"   TEXT NOT NULL,
      "informedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "actorId"    TEXT,
      "channel"    TEXT,
      PRIMARY KEY ("tenantId", "personId")
    )`);
  schemaReady = true;
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Namens-Hash fuer die Wiedererfassungs-Sperre (firmenunabhaengig). */
export function personNameHash(fullName: string): string {
  return `name:${sha256(nameIdentityForm(fullName))}`;
}

/** Profil-Hash (LinkedIn kanonisch / XING) — leer, wenn keine Profil-URL. */
export function personUrlHash(url: string | null | undefined): string | null {
  if (!url) return null;
  const canon = normalizeLinkedInProfileUrl(url) ?? url.trim().toLowerCase();
  return canon ? `url:${sha256(canon)}` : null;
}

/** Nach dem Persist: Beobachtungen mit erhebendem Tenant/Nutzer stempeln. */
export async function stampObservations(pool: pg.Pool, ids: string[], tenantId: string | null, actorId: string | null): Promise<void> {
  if (ids.length === 0 || (!tenantId && !actorId)) return;
  await ensurePersonComplianceSchema(pool);
  await pool.query(
    `UPDATE "Observation" SET "tenantId" = COALESCE("tenantId", $2), "actorId" = COALESCE("actorId", $3) WHERE "id" = ANY($1::text[])`,
    [ids, tenantId, actorId],
  );
}

/** Sperre pruefen: Person mit diesem Namen/Profil wurde geloescht? */
export async function isPersonTombstoned(pool: pg.Pool, args: { fullName: string; linkedinUrl?: string | null; xingUrl?: string | null }): Promise<boolean> {
  await ensurePersonComplianceSchema(pool);
  const hashes = [personNameHash(args.fullName)];
  const u = personUrlHash(args.linkedinUrl) ?? personUrlHash(args.xingUrl);
  if (u) hashes.push(u);
  const r = await pool.query(`SELECT 1 FROM "PersonTombstone" WHERE "hash" = ANY($1::text[]) LIMIT 1`, [hashes]);
  return r.rows.length > 0;
}

export interface HerkunftBericht {
  person: { id: string; fullName: string; givenName: string | null; familyName: string | null; location: string | null; createdAt: string; updatedAt: string };
  fakten: Array<{ field: string; value: string; status: string; confidence: number; firstSeen: string; lastSeen: string; companyId: string | null }>;
  beobachtungen: Array<{ field: string; value: string; source: string; evidenceUrl: string | null; evidence: string | null; observedAt: string; runId: string | null; tenantId: string | null; actorId: string | null; companyId: string | null }>;
  beschaeftigungen: Array<{ companyId: string; companyName: string | null; title: string | null; department: string | null; isCurrent: boolean; firstSeen: string; lastSeen: string; quellen: Array<{ source: string; url: string | null; observedAt: string | null }> }>;
  erhebendeTenants: string[];
  letzteBeobachtung: string | null;
  informiert: Array<{ tenantId: string; informedAt: string; channel: string | null }>;
  /** BC6 — Einschaetzungen im Buying Center der anfragenden Organisation (Art. 15). */
  einschaetzungen?: BuyingCenterEinschaetzung[];
}

/**
 * BC6 (docs/PLAN_BUYING_CENTER.md, Abschnitt 10) — Was ein Buying Center
 * ueber diese Person festhaelt: die vier Dimensionen, die Belegkette mit
 * Autor und Grund, die Beziehungen. Samt "Feind", wenn es so drinsteht —
 * Auskunft heisst Auskunft. Nur die Buying Center der ANFRAGENDEN
 * Organisation: Fuer die anderen ist sie nicht verantwortlich.
 */
export interface BuyingCenterEinschaetzung {
  buyingCenterId: string;
  companyId: string;
  companyName: string | null;
  anlass: string;
  status: string;
  /** Eigentuemer als E-Mail oder Name, sonst die Kennung — Autorenschaft ist Pflicht. */
  eigentuemer: string;
  angelegtAt: string;
  updatedAt: string;
  name: string;
  funktion: string | null;
  rollen: string[];
  einstellung: string | null;
  kontakt: string | null;
  einfluss: string | null;
  angaben: Array<{ dimension: string; wert: string | null; herkunft: string; grund: string; entschieden: string | null; von: string | null; erfasstAt: string }>;
  beziehungen: Array<{ richtung: "von" | "zu"; andere: string; art: string; staerke: string | null; grund: string | null; von: string | null; erfasstAt: string }>;
}

export async function buyingCenterEinschaetzungen(
  gateway: pg.Pool,
  kontakte: pg.Pool,
  args: { personId: string; tenantId: string },
): Promise<BuyingCenterEinschaetzung[]> {
  const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
  const m = await gateway.query<{
    mitgliedId: string; name: string; funktion: string | null; rollen: string[] | null; einstellung: string | null; kontakt: string | null; einfluss: string | null;
    buyingCenterId: string; companyId: string; anlass: string; status: string; eigentuemerActorId: string; angelegtAt: Date; updatedAt: Date;
    eigentuemerEmail: string | null; eigentuemerName: string | null;
  }>(
    `SELECT m."id" AS "mitgliedId", m."name", m."funktion", m."rollen", m."einstellung", m."kontakt", m."einfluss",
            b."id" AS "buyingCenterId", b."companyId", b."anlass", b."status", b."eigentuemerActorId", b."angelegtAt", b."updatedAt",
            t."email" AS "eigentuemerEmail", t."name" AS "eigentuemerName"
       FROM "BuyingCenterMitglied" m
       JOIN "BuyingCenter" b ON b."id" = m."buyingCenterId"
       LEFT JOIN "TenantMember" t ON t."actorId" = b."eigentuemerActorId"
      WHERE m."personId" = $1 AND b."tenantId" = $2
      ORDER BY b."angelegtAt"`,
    [args.personId, args.tenantId],
  );
  if (m.rows.length === 0) return [];
  const mitgliedIds = m.rows.map((r) => r.mitgliedId);
  const [a, k, c] = await Promise.all([
    gateway.query<{ mitgliedId: string; dimension: string; wert: string | null; herkunft: string; grund: string; entschieden: string | null; erfasstAt: Date; vonActorId: string | null; vonEmail: string | null; vonName: string | null }>(
      `SELECT a."mitgliedId", a."dimension", a."wert", a."herkunft", a."grund", a."entschieden", a."erfasstAt", a."vonActorId",
              t."email" AS "vonEmail", t."name" AS "vonName"
         FROM "BuyingCenterAngabe" a LEFT JOIN "TenantMember" t ON t."actorId" = a."vonActorId"
        WHERE a."mitgliedId" = ANY($1::text[]) ORDER BY a."erfasstAt" DESC`,
      [mitgliedIds],
    ),
    gateway.query<{ vonMitgliedId: string; nachMitgliedId: string; vonNameM: string; nachNameM: string; art: string; staerke: string | null; grund: string | null; erfasstAt: Date; vonActorId: string | null; vonEmail: string | null; vonName: string | null }>(
      `SELECT k."vonMitgliedId", k."nachMitgliedId", mv."name" AS "vonNameM", mn."name" AS "nachNameM", k."art", k."staerke", k."grund", k."erfasstAt", k."vonActorId",
              t."email" AS "vonEmail", t."name" AS "vonName"
         FROM "BuyingCenterKante" k
         JOIN "BuyingCenterMitglied" mv ON mv."id" = k."vonMitgliedId"
         JOIN "BuyingCenterMitglied" mn ON mn."id" = k."nachMitgliedId"
         LEFT JOIN "TenantMember" t ON t."actorId" = k."vonActorId"
        WHERE k."vonMitgliedId" = ANY($1::text[]) OR k."nachMitgliedId" = ANY($1::text[])
        ORDER BY k."erfasstAt"`,
      [mitgliedIds],
    ),
    kontakte.query<{ id: string; name: string | null }>(
      `SELECT "id", "name" FROM "Company" WHERE "id" = ANY($1::text[])`,
      [Array.from(new Set(m.rows.map((r) => r.companyId)))],
    ).catch(() => ({ rows: [] as Array<{ id: string; name: string | null }> })),
  ]);
  const firmenname = new Map(c.rows.map((r) => [r.id, r.name]));
  const wer = (email: string | null, name: string | null, actorId: string | null) => email ?? name ?? actorId;
  return m.rows.map((r) => ({
    buyingCenterId: r.buyingCenterId,
    companyId: r.companyId,
    companyName: firmenname.get(r.companyId) ?? null,
    anlass: r.anlass,
    status: r.status,
    eigentuemer: wer(r.eigentuemerEmail, r.eigentuemerName, r.eigentuemerActorId) ?? r.eigentuemerActorId,
    angelegtAt: iso(r.angelegtAt)!,
    updatedAt: iso(r.updatedAt)!,
    name: r.name,
    funktion: r.funktion,
    rollen: r.rollen ?? [],
    einstellung: r.einstellung,
    kontakt: r.kontakt,
    einfluss: r.einfluss,
    angaben: a.rows.filter((x) => x.mitgliedId === r.mitgliedId).map((x) => ({
      dimension: x.dimension, wert: x.wert, herkunft: x.herkunft, grund: x.grund, entschieden: x.entschieden,
      von: wer(x.vonEmail, x.vonName, x.vonActorId), erfasstAt: iso(x.erfasstAt)!,
    })),
    beziehungen: k.rows
      .filter((x) => x.vonMitgliedId === r.mitgliedId || x.nachMitgliedId === r.mitgliedId)
      .map((x) => ({
        richtung: x.vonMitgliedId === r.mitgliedId ? ("von" as const) : ("zu" as const),
        andere: x.vonMitgliedId === r.mitgliedId ? x.nachNameM : x.vonNameM,
        art: x.art, staerke: x.staerke, grund: x.grund,
        von: wer(x.vonEmail, x.vonName, x.vonActorId), erfasstAt: iso(x.erfasstAt)!,
      })),
  }));
}

export async function personHerkunft(pool: pg.Pool, personId: string): Promise<HerkunftBericht | null> {
  await ensurePersonComplianceSchema(pool);
  const p = await pool.query<{ id: string; fullName: string; givenName: string | null; familyName: string | null; location: string | null; createdAt: Date; updatedAt: Date }>(
    `SELECT "id", "fullName", "givenName", "familyName", "location", "createdAt", "updatedAt" FROM "Person" WHERE "id" = $1`,
    [personId],
  );
  const person = p.rows[0];
  if (!person) return null;
  const [f, o, e, n] = await Promise.all([
    pool.query<{ field: string; value: string; status: string; confidence: number; firstSeen: Date; lastSeen: Date; companyId: string | null }>(
      `SELECT "field", "value", "status", "confidence", "firstSeen", "lastSeen", "companyId" FROM "Fact" WHERE "personId" = $1 ORDER BY "field", "lastSeen" DESC`,
      [personId],
    ),
    pool.query<{ field: string; value: string; source: string; evidenceUrl: string | null; evidence: string | null; observedAt: Date; runId: string | null; tenantId: string | null; actorId: string | null; companyId: string | null }>(
      `SELECT "field", "value", "source", "evidenceUrl", "evidence", "observedAt", "runId", "tenantId", "actorId", "companyId" FROM "Observation" WHERE "personId" = $1 ORDER BY "observedAt" DESC`,
      [personId],
    ),
    pool.query<{ id: string; companyId: string; companyName: string | null; title: string | null; department: string | null; isCurrent: boolean; firstSeen: Date; lastSeen: Date }>(
      `SELECT e."id", e."companyId", c."name" AS "companyName", e."title", e."department", e."isCurrent", e."firstSeen", e."lastSeen"
         FROM "Employment" e LEFT JOIN "Company" c ON c."id" = e."companyId" WHERE e."personId" = $1 ORDER BY e."lastSeen" DESC`,
      [personId],
    ),
    pool.query<{ tenantId: string; informedAt: Date; channel: string | null }>(`SELECT "tenantId", "informedAt", "channel" FROM "PersonNotice" WHERE "personId" = $1`, [personId]),
  ]);
  const quellen = e.rows.length
    ? await pool.query<{ employmentId: string; source: string; url: string | null; observedAt: Date | null }>(
        `SELECT "employmentId", "source", "url", "observedAt" FROM "EmploymentSource" WHERE "employmentId" = ANY($1::text[])`,
        [e.rows.map((x) => x.id)],
      ).catch(() => ({ rows: [] as Array<{ employmentId: string; source: string; url: string | null; observedAt: Date | null }> }))
    : { rows: [] as Array<{ employmentId: string; source: string; url: string | null; observedAt: Date | null }> };
  const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);
  const tenants = Array.from(new Set(o.rows.map((x) => x.tenantId).filter((x): x is string => !!x)));
  const zeiten = [...o.rows.map((x) => x.observedAt), ...e.rows.map((x) => x.lastSeen), person.updatedAt].map((d) => new Date(d).getTime());
  return {
    person: { ...person, createdAt: iso(person.createdAt)!, updatedAt: iso(person.updatedAt)! },
    fakten: f.rows.map((x) => ({ ...x, firstSeen: iso(x.firstSeen)!, lastSeen: iso(x.lastSeen)! })),
    beobachtungen: o.rows.map((x) => ({ ...x, observedAt: iso(x.observedAt)! })),
    beschaeftigungen: e.rows.map((x) => ({
      companyId: x.companyId, companyName: x.companyName, title: x.title, department: x.department, isCurrent: x.isCurrent,
      firstSeen: iso(x.firstSeen)!, lastSeen: iso(x.lastSeen)!,
      quellen: quellen.rows.filter((q) => q.employmentId === x.id).map((q) => ({ source: q.source, url: q.url, observedAt: iso(q.observedAt) })),
    })),
    erhebendeTenants: tenants,
    letzteBeobachtung: zeiten.length ? new Date(Math.max(...zeiten)).toISOString() : null,
    informiert: n.rows.map((x) => ({ tenantId: x.tenantId, informedAt: iso(x.informedAt)!, channel: x.channel })),
  };
}

const FELD: Record<string, string> = {
  fullName: "Name", jobTitle: "Position", department: "Abteilung", linkedinUrl: "LinkedIn-Profil", xingUrl: "XING-Profil",
  email: "E-Mail", phone: "Telefon", identityKey: "Identitaetsschluessel (intern)", employmentCompanyId: "Firmenzuordnung (intern)",
  websiteHervorhebung: "Hervorhebung auf der Firmenwebsite (Platz, Foto, Zitat)",
};
const d = (iso: string | null) => (iso ? iso.slice(0, 10) : "—");

/** Buying-Center-Kuerzel ausgeschrieben, damit die betroffene Person sie versteht. */
const BC_WORT: Record<string, string> = {
  E: "Entscheider", B: "Beeinflusser", N: "Nutzer/Anwender", R: "Ratifizierer", S: "Spezifizierer", EK: "Einkaeufer", GK: "Gatekeeper",
  C: "Coach", "+": "positiv", "=": "neutral", "-": "negativ", F: "Feind",
  "0": "kein Kontakt", I: "intensiv", G: "gering", M: "mittel", H: "hoch",
};
function bcWort(v: string | null | undefined): string {
  if (v === null || v === undefined || v === "") return "offen";
  // "S" und "R" sind je nach Dimension Spezifizierer/selten bzw. Ratifizierer/regelmaessig;
  // das Kuerzel bleibt sichtbar, damit nichts verwechselt wird.
  const w = BC_WORT[v];
  return w ? `${v} (${w})` : v;
}

/** Druckbarer Herkunftsnachweis (Markdown) — Antwort auf ein Auskunftsersuchen nach Art. 15 DSGVO. */
export function herkunftAlsMarkdown(b: HerkunftBericht, opts: { tenantName?: string | null } = {}): string {
  const L: string[] = [];
  L.push(`# Herkunftsnachweis: ${b.person.fullName}`);
  L.push("");
  L.push(`Erstellt am ${new Date().toISOString().slice(0, 10)}${opts.tenantName ? ` fuer ${opts.tenantName}` : ""}. Alle Angaben stammen aus oeffentlich zugaenglichen Quellen (Firmenwebsites, Register, berufliche Netzwerke). Quelle, Beleg und Zeitpunkt sind je Angabe aufgefuehrt.`);
  L.push("");
  L.push(`- Person-ID: \`${b.person.id}\``);
  L.push(`- Erstmals erfasst: ${d(b.person.createdAt)} · letzte Beobachtung: ${d(b.letzteBeobachtung)}`);
  L.push(`- Erhebende Organisationen (Tenant-IDs): ${b.erhebendeTenants.length ? b.erhebendeTenants.join(", ") : "Altbestand ohne Zuordnung"}`);
  if (b.informiert.length) L.push(`- Information nach Art. 14: ${b.informiert.map((i) => `${d(i.informedAt)}${i.channel ? ` (${i.channel})` : ""}`).join(", ")}`);
  L.push("");
  L.push("## Gespeicherte Angaben (Fakten)");
  L.push("");
  L.push("| Feld | Wert | Status | Konfidenz | zuerst | zuletzt |");
  L.push("|---|---|---|---|---|---|");
  for (const f of b.fakten.filter((x) => !["identityKey", "employmentCompanyId"].includes(x.field))) {
    L.push(`| ${FELD[f.field] ?? f.field} | ${f.value.replace(/\|/g, "\\|")} | ${f.status} | ${Math.round(f.confidence * 100)} % | ${d(f.firstSeen)} | ${d(f.lastSeen)} |`);
  }
  L.push("");
  L.push("## Beschaeftigungen");
  L.push("");
  if (b.beschaeftigungen.length === 0) L.push("keine");
  for (const e of b.beschaeftigungen) {
    L.push(`- **${e.companyName ?? e.companyId}**${e.title ? ` · ${e.title}` : ""}${e.department ? ` · ${e.department}` : ""} · ${e.isCurrent ? "aktuell" : "beendet"} · beobachtet ${d(e.firstSeen)} bis ${d(e.lastSeen)}`);
    for (const q of e.quellen) L.push(`  - Quelle: ${q.source}${q.url ? ` — ${q.url}` : ""}${q.observedAt ? ` (${d(q.observedAt)})` : ""}`);
  }
  L.push("");
  L.push("## Beobachtungen (Beleg je Angabe)");
  L.push("");
  L.push("| Zeitpunkt | Feld | Wert | Quelle | Beleg | Lauf | erhoben von |");
  L.push("|---|---|---|---|---|---|---|");
  for (const o of b.beobachtungen.filter((x) => !["identityKey", "employmentCompanyId"].includes(x.field))) {
    L.push(`| ${d(o.observedAt)} | ${FELD[o.field] ?? o.field} | ${o.value.replace(/\|/g, "\\|")} | ${o.source} | ${o.evidenceUrl ?? "—"} | ${o.runId ? o.runId.slice(0, 8) : "—"} | ${o.tenantId ?? "—"} |`);
  }
  if (b.einschaetzungen) {
    L.push("");
    L.push("## Einschaetzungen im Buying Center");
    L.push("");
    L.push("Ein Buying Center ist die persoenliche Arbeitshypothese EINES Vertriebsmitarbeiters darueber, wer bei einem Unternehmen am Kauf beteiligt ist. Die folgenden Angaben sind Einschaetzungen, keine Tatsachen; jede traegt Autor, Zeitpunkt und Begruendung. Vorschlaege von AVA (Herkunft ava:…) gelten erst, wenn ein Mitarbeiter sie angenommen hat.");
    L.push("");
    if (b.einschaetzungen.length === 0) L.push("keine");
    for (const e of b.einschaetzungen) {
      L.push(`### ${e.companyName ?? e.companyId}${e.anlass ? ` · Anlass "${e.anlass}"` : ""} · Stand: ${e.status} · Eigentuemer: ${e.eigentuemer} · angelegt ${d(e.angelegtAt)}, zuletzt geaendert ${d(e.updatedAt)}`);
      L.push("");
      L.push(`- Name im Buying Center: ${e.name}${e.funktion ? ` · Funktion: ${e.funktion}` : ""}`);
      L.push(`- Rolle: ${e.rollen.length ? e.rollen.map(bcWort).join(", ") : "offen"} · Einstellung: ${bcWort(e.einstellung)} · Kontaktintensitaet: ${bcWort(e.kontakt)} · Einfluss: ${bcWort(e.einfluss)}`);
      if (e.angaben.length) {
        L.push("");
        L.push("| Zeitpunkt | Dimension | Wert | Herkunft | Begruendung | Entscheidung | Autor |");
        L.push("|---|---|---|---|---|---|---|");
        for (const a of e.angaben) {
          L.push(`| ${d(a.erfasstAt)} | ${a.dimension} | ${a.wert === null ? "—" : bcWort(a.wert)} | ${a.herkunft} | ${a.grund.replace(/\|/g, "\\|")} | ${a.entschieden ?? (a.herkunft === "nutzer" ? "gesetzt" : "offen")} | ${a.von ?? "AVA"} |`);
        }
      }
      if (e.beziehungen.length) {
        L.push("");
        L.push("Beziehungen:");
        for (const r of e.beziehungen) {
          const was = r.art === "EINFLUSS" ? (r.richtung === "von" ? "beeinflusst" : "wird beeinflusst von") : r.art === "VERTRAUT" ? "vertraut mit" : "Animositaet mit";
          L.push(`- ${was} ${r.andere}${r.staerke ? ` (${bcWort(r.staerke)})` : ""}${r.grund ? ` — ${r.grund}` : ""} · ${d(r.erfasstAt)} · ${r.von ?? "AVA"}`);
        }
      }
      L.push("");
    }
  }
  L.push("");
  L.push("## Rechte der betroffenen Person");
  L.push("");
  L.push("Auskunft, Berichtigung, Loeschung und Widerspruch koennen jederzeit gegenueber der erhebenden Organisation geltend gemacht werden. Eine Loeschung tilgt die Person im gesamten Bestand und sperrt die Wiedererfassung ueber Namens- und Profil-Kennung.");
  return L.join("\n");
}

/** Art.-14-Hinweistext (vorformuliert) fuer den Kontakt. */
export function art14Hinweis(b: HerkunftBericht, opts: { organisation: string; kontaktEmail?: string | null; retentionDays: number }): string {
  const quellen = Array.from(new Set(b.beobachtungen.map((o) => o.source))).join(", ") || "oeffentliche Quellen";
  const firmen = Array.from(new Set(b.beschaeftigungen.map((e) => e.companyName ?? e.companyId))).join(", ");
  return [
    `Information nach Art. 14 DSGVO`,
    ``,
    `Sehr geehrte/r ${b.person.fullName},`,
    ``,
    `${opts.organisation} hat berufliche Kontaktdaten zu Ihrer Person aus oeffentlich zugaenglichen Quellen (${quellen}) erhoben${firmen ? `, im Zusammenhang mit ${firmen}` : ""}. Gespeichert sind: ${b.fakten.filter((f) => !["identityKey", "employmentCompanyId"].includes(f.field)).map((f) => FELD[f.field] ?? f.field).filter((v, i, a) => a.indexOf(v) === i).join(", ") || "Name und Position"}.`,
    ``,
    ...(b.beobachtungen.some((o) => o.source.startsWith("pattern:"))
      ? [`Hinweis: Ihre E-Mail-Adresse wurde nach dem Adressmuster Ihres Unternehmens gebildet und technisch auf Existenz geprueft (SMTP-Anfrage ohne Zustellung einer E-Mail).`]
      : []),
    ...(b.einschaetzungen && b.einschaetzungen.length > 0
      ? [`Zudem sind interne Einschaetzungen zu Ihrer Rolle in einem Kaufprozess (Buying Center: Rolle, Einstellung, Kontaktintensitaet, Einfluss) gespeichert, die ein Mitarbeiter mit Begruendung erfasst hat.`]
      : []),
    `Zweck: Recherche und Kontaktaufnahme im geschaeftlichen Kontext (Art. 6 Abs. 1 lit. f DSGVO, berechtigtes Interesse an B2B-Vertriebskommunikation).`,
    `Speicherdauer: Die Daten werden geloescht, wenn sie ${opts.retentionDays} Tage lang auf keiner Quelle mehr bestaetigt wurden, spaetestens jedoch auf Ihren Widerspruch hin.`,
    `Ihre Rechte: Auskunft, Berichtigung, Loeschung, Einschraenkung der Verarbeitung, Widerspruch (Art. 15–21 DSGVO) sowie Beschwerde bei einer Aufsichtsbehoerde.`,
    `Kontakt: ${opts.kontaktEmail ?? "[Datenschutz-Kontakt der Organisation eintragen]"}`,
    ``,
    `Mit freundlichen Gruessen`,
    `${opts.organisation}`,
  ].join("\n");
}

/** Person loeschen (global) + Sperre gegen Wiedererfassung. */
export async function deletePerson(pool: pg.Pool, args: { personId: string; tenantId: string; actorId: string; reason: string | null }): Promise<{ deleted: boolean; tombstones: number; fullName: string | null }> {
  await ensurePersonComplianceSchema(pool);
  const p = await pool.query<{ fullName: string }>(`SELECT "fullName" FROM "Person" WHERE "id" = $1`, [args.personId]);
  const person = p.rows[0];
  if (!person) return { deleted: false, tombstones: 0, fullName: null };
  const facts = await pool.query<{ field: string; value: string }>(
    `SELECT "field", "value" FROM "Fact" WHERE "personId" = $1 AND "field" IN ('linkedinUrl', 'xingUrl', 'fullName')`,
    [args.personId],
  );
  const hashes = new Set<string>([personNameHash(person.fullName)]);
  for (const f of facts.rows) {
    if (f.field === "fullName") hashes.add(personNameHash(f.value));
    else {
      const h = personUrlHash(f.value);
      if (h) hashes.add(h);
    }
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const h of hashes) {
      await client.query(
        `INSERT INTO "PersonTombstone" ("hash", "kind", "personId", "fullName", "tenantId", "deletedBy", "reason")
         VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT ("hash") DO NOTHING`,
        [h, h.startsWith("url:") ? "url" : "name", args.personId, person.fullName, args.tenantId, args.actorId, args.reason],
      );
    }
    await client.query(`DELETE FROM "Person" WHERE "id" = $1`, [args.personId]); // Cascade: Employment, Fact, Observation, SignalEvent
    await client.query(`DELETE FROM "PersonNotice" WHERE "personId" = $1`, [args.personId]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  logger.info({ personId: args.personId, tenantId: args.tenantId, actorId: args.actorId, tombstones: hashes.size }, "person deleted (C1)");
  return { deleted: true, tombstones: hashes.size, fullName: person.fullName };
}

export async function setInformed(pool: pg.Pool, args: { personId: string; tenantId: string; actorId: string; channel: string | null }): Promise<void> {
  await ensurePersonComplianceSchema(pool);
  await pool.query(
    `INSERT INTO "PersonNotice" ("tenantId", "personId", "actorId", "channel") VALUES ($1, $2, $3, $4)
     ON CONFLICT ("tenantId", "personId") DO UPDATE SET "informedAt" = NOW(), "actorId" = EXCLUDED."actorId", "channel" = EXCLUDED."channel"`,
    [args.tenantId, args.personId, args.actorId, args.channel],
  );
}

/** Aufbewahrung: Personen tilgen, die laenger als N Tage von keinem Lauf mehr gesehen wurden.
 *  N = kleinster Wert der erhebenden Tenants (Policy), sonst Standard. */
export async function purgeStalePersons(pool: pg.Pool, args: { retentionByTenant: Map<string, number>; defaultDays?: number; limit?: number; dryRun?: boolean }): Promise<{ geprueft: number; getilgt: number }> {
  await ensurePersonComplianceSchema(pool);
  const defaultDays = args.defaultDays ?? DEFAULT_PERSON_RETENTION_DAYS;
  const minDays = Math.min(defaultDays, ...Array.from(args.retentionByTenant.values()));
  const r = await pool.query<{ id: string; lastSeen: Date; tenants: string[] }>(
    `SELECT p."id",
            GREATEST(p."updatedAt", COALESCE((SELECT MAX(o."observedAt") FROM "Observation" o WHERE o."personId" = p."id"), p."updatedAt"),
                     COALESCE((SELECT MAX(e."lastSeen") FROM "Employment" e WHERE e."personId" = p."id"), p."updatedAt")) AS "lastSeen",
            ARRAY(SELECT DISTINCT o."tenantId" FROM "Observation" o WHERE o."personId" = p."id" AND o."tenantId" IS NOT NULL) AS tenants
       FROM "Person" p
      WHERE p."updatedAt" < NOW() - ($1 || ' days')::interval
      LIMIT $2`,
    [String(minDays), args.limit ?? 500],
  );
  const now = Date.now();
  let getilgt = 0;
  for (const row of r.rows) {
    const tage = row.tenants.length
      ? Math.min(...row.tenants.map((t) => args.retentionByTenant.get(t) ?? defaultDays))
      : defaultDays;
    const alter = (now - new Date(row.lastSeen).getTime()) / 86_400_000;
    if (alter < tage) continue;
    if (!args.dryRun) {
      await pool.query(`DELETE FROM "Person" WHERE "id" = $1`, [row.id]);
      await pool.query(`DELETE FROM "PersonNotice" WHERE "personId" = $1`, [row.id]);
    }
    getilgt++;
  }
  return { geprueft: r.rows.length, getilgt };
}
