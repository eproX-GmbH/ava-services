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
};
const d = (iso: string | null) => (iso ? iso.slice(0, 10) : "—");

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
