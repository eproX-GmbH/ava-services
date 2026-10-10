// Doppelte Personen einer Firma zusammenführen (Befund 2026-10-10: bei QUIKK standen
// „Christian“ – LinkedIn-Suche, Profil linkedin.com/in/christiankrebel – und
// „Christian Krebel“ – Mitarbeiterliste ohne Profil-URL – als zwei Kontakte).
//
// Stufe 1, deterministisch, hier im Gateway:
//   gleiches-profil  dieselbe LinkedIn- oder Xing-Profil-URL
//   profil-name      der LinkedIn-Slug ist genau der volle Name der anderen Person
//   gleiche-mail     dieselbe belegte (gefundene oder per SMTP bestätigte) Adresse bei dieser Firma
// Immer nur, wenn die Namen verträglich sind („Christian“ ⊂ „Christian Krebel“).
//
// Stufe 2, Kandidaten fürs KI-Urteil in der AVA (der Gateway ruft kein LLM):
//   Eine Person trägt nur einen Vornamen, und bei der Firma gibt es GENAU eine Person
//   mit diesem Vornamen und Nachnamen, ohne widersprechende Profil-URL.
//
// Zusammenführen hängt Fakten, Belege, Signale und Beschäftigungen an die verbleibende
// Person; doppelte Fakten werden gelöscht und im Protokoll gesichert. Jede
// Zusammenführung steht in "PersonZusammenfuehrung" und lässt sich zurücknehmen.

import type pg from "pg";
import { randomUUID } from "node:crypto";
import { falteUmlaute, nameIdentityForm } from "./sanitize-person";
import { normalizeLinkedInProfileUrl } from "./employee-contact";

export type Regel = "gleiches-profil" | "profil-name" | "gleiche-mail" | "urteil";

let schemaBereit = false;
export async function ensureZusammenfuehrungSchema(pool: pg.Pool): Promise<void> {
  if (schemaBereit) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "PersonZusammenfuehrung" (
      "id"             TEXT PRIMARY KEY,
      "companyId"      TEXT NOT NULL,
      "behaltenId"     TEXT NOT NULL,
      "aufgeloestId"   TEXT NOT NULL,
      "aufgeloestName" TEXT NOT NULL,
      "behaltenName"   TEXT NOT NULL,
      "regel"          TEXT NOT NULL,
      "grund"          TEXT,
      "protokoll"      JSONB NOT NULL,
      "actorId"        TEXT,
      "createdAt"      TIMESTAMPTZ NOT NULL DEFAULT now(),
      "rueckgaengigAt" TIMESTAMPTZ
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS "PersonZusammenfuehrung_companyId_idx" ON "PersonZusammenfuehrung"("companyId")`);
  schemaBereit = true;
}

// ---- Personen einer Firma ----------------------------------------------------------

export interface PersonKurz {
  id: string;
  fullName: string;
  createdAt: string;
  tokens: string[];
  /** Kanonische LinkedIn-Profile und Xing-URLs. */
  profile: string[];
  /** LinkedIn-Slugs, gefaltet, nur Buchstaben und Ziffern. */
  slugs: string[];
  /** Belegte Adressen bei dieser Firma (gefunden oder per SMTP bestätigt). */
  mailsBelegt: string[];
  titel: string | null;
  abteilung: string | null;
  beschreibung: string | null;
  quellen: string[];
}

const UNBELEGT = /^(pattern|zuordnung):(offen|abgelehnt|catchall)$/;

function slugVon(linkedin: string): string | null {
  const m = /linkedin\.com\/in\/([^/?#]+)/i.exec(linkedin);
  if (!m) return null;
  let s = m[1]!;
  try {
    s = decodeURIComponent(s);
  } catch {
    /* roh lassen */
  }
  return falteUmlaute(s.toLowerCase()).normalize("NFD").replace(/\p{M}+/gu, "").replace(/[^a-z0-9]/g, "") || null;
}

export function namensTokens(fullName: string): string[] {
  return nameIdentityForm(fullName)
    .split(" ")
    .map((t) => t.replace(/[^a-z0-9.-]/g, ""))
    .filter((t) => t.replace(/\./g, "").length >= 1);
}

/** Die kürzere Namensform steckt in der längeren („christian“ ⊂ „christian krebel“; „b.“ passt zu „buck“). */
export function namenVertraeglich(a: string[], b: string[]): boolean {
  const [kurz, lang] = a.length <= b.length ? [a, b] : [b, a];
  if (kurz.length === 0) return false;
  const frei = [...lang];
  for (const t of kurz) {
    const initial = /^[a-z]\.?$/.test(t) ? t[0] : null;
    const i = frei.findIndex((x) => (initial ? x.startsWith(initial) : x === t));
    if (i < 0) return false;
    frei.splice(i, 1);
  }
  return true;
}

export async function personenDerFirma(q: pg.Pool | pg.PoolClient, companyId: string): Promise<PersonKurz[]> {
  const p = await q.query<{ id: string; fullName: string; createdAt: Date }>(
    `SELECT p."id", p."fullName", p."createdAt" FROM "Person" p
      WHERE EXISTS (SELECT 1 FROM "Employment" e WHERE e."personId" = p."id" AND e."companyId" = $1)
      ORDER BY p."createdAt"`,
    [companyId],
  );
  if (p.rows.length === 0) return [];
  const ids = p.rows.map((r) => r.id);
  const f = await q.query<{ personId: string; field: string; value: string; normalized: string | null; status: string; companyId: string | null; source: string | null }>(
    `SELECT f."personId", f."field", f."value", f."normalized", f."status", f."companyId", o."source"
       FROM "Fact" f LEFT JOIN "Observation" o ON o."id" = f."lastObsId"
      WHERE f."entityType" = 'PERSON' AND f."personId" = ANY($1::text[])
        AND f."field" IN ('identityKey', 'linkedinUrl', 'xingUrl', 'email', 'jobTitle', 'department', 'websiteBeschreibung')`,
    [ids],
  );
  return p.rows.map((r) => {
    const fakten = f.rows.filter((x) => x.personId === r.id);
    const aktiv = fakten.filter((x) => x.status === "ACTIVE");
    const profile = new Set<string>();
    const slugs = new Set<string>();
    for (const x of fakten) {
      const roh = x.field === "identityKey" ? (x.normalized ?? x.value).replace(/^url:/, "") : x.field === "linkedinUrl" || x.field === "xingUrl" ? x.value : null;
      if (!roh || (x.field === "identityKey" && !(x.normalized ?? x.value).startsWith("url:"))) continue;
      const li = normalizeLinkedInProfileUrl(roh);
      if (li) {
        profile.add(li.toLowerCase());
        const s = slugVon(li);
        if (s) slugs.add(s);
      } else if (/xing\.com\/profile\//i.test(roh)) profile.add(roh.toLowerCase().replace(/\/+$/, ""));
    }
    const erstes = (feld: string) => aktiv.find((x) => x.field === feld && (x.companyId === companyId || !x.companyId))?.value ?? null;
    return {
      id: r.id,
      fullName: r.fullName,
      createdAt: new Date(r.createdAt).toISOString(),
      tokens: namensTokens(r.fullName),
      profile: [...profile],
      slugs: [...slugs],
      mailsBelegt: aktiv.filter((x) => x.field === "email" && x.companyId === companyId && !UNBELEGT.test(x.source ?? "")).map((x) => x.value.toLowerCase()),
      titel: erstes("jobTitle"),
      abteilung: erstes("department"),
      beschreibung: erstes("websiteBeschreibung"),
      quellen: [...new Set(aktiv.map((x) => x.source).filter((s): s is string => !!s))].slice(0, 6),
    };
  });
}

// ---- Regeln ----------------------------------------------------------------------------

/** Behalten wird die Person mit dem volleren Namen, bei Gleichstand die ältere. */
export function wenBehalten(a: PersonKurz, b: PersonKurz): [PersonKurz, PersonKurz] {
  if (a.tokens.length !== b.tokens.length) return a.tokens.length > b.tokens.length ? [a, b] : [b, a];
  return a.createdAt <= b.createdAt ? [a, b] : [b, a];
}

const profilWiderspruch = (a: PersonKurz, b: PersonKurz) => a.profile.length > 0 && b.profile.length > 0 && !a.profile.some((x) => b.profile.includes(x));

/** Passt der LinkedIn-Slug von x genau zum vollen Namen von y? „christiankrebel“ ↔ „Christian Krebel“, auch mit Kennungs-Anhang („…-4a1b2c“). */
function slugPasstZuName(x: PersonKurz, y: PersonKurz): boolean {
  if (y.tokens.length < 2) return false;
  const name = y.tokens.join("").replace(/[^a-z0-9]/g, "");
  if (name.length < 8) return false;
  return x.slugs.some((s) => s === name || (s.startsWith(name) && /^[a-z0-9]{1,12}$/.test(s.slice(name.length)) && /\d/.test(s.slice(name.length))));
}

export interface Paar {
  behalten: PersonKurz;
  aufloesen: PersonKurz;
  regel: Regel;
  grund: string;
}

/** Stufe 1: sichere Paare (jede Person höchstens einmal je Durchlauf). */
export function sicherePaare(personen: PersonKurz[]): Paar[] {
  const paare: Paar[] = [];
  const vergeben = new Set<string>();
  for (let i = 0; i < personen.length; i++) {
    for (let j = i + 1; j < personen.length; j++) {
      const a = personen[i]!, b = personen[j]!;
      if (vergeben.has(a.id) || vergeben.has(b.id) || !namenVertraeglich(a.tokens, b.tokens)) continue;
      let regel: Regel | null = null;
      let grund = "";
      const gemeinsam = a.profile.find((x) => b.profile.includes(x));
      if (gemeinsam) {
        regel = "gleiches-profil";
        grund = `gleiches Profil ${gemeinsam}`;
      } else if (!profilWiderspruch(a, b) && (slugPasstZuName(a, b) || slugPasstZuName(b, a))) {
        regel = "profil-name";
        grund = `LinkedIn-Profil ${(slugPasstZuName(a, b) ? a : b).profile[0] ?? ""} trägt den vollen Namen ${(slugPasstZuName(a, b) ? b : a).fullName}`;
      } else if (!profilWiderspruch(a, b)) {
        const mail = a.mailsBelegt.find((x) => b.mailsBelegt.includes(x));
        if (mail) {
          regel = "gleiche-mail";
          grund = `gleiche belegte Adresse ${mail}`;
        }
      }
      if (!regel) continue;
      const [behalten, aufloesen] = wenBehalten(a, b);
      paare.push({ behalten, aufloesen, regel, grund });
      vergeben.add(a.id);
      vergeben.add(b.id);
    }
  }
  return paare;
}

export interface Kandidat {
  vorname: PersonKurz;
  voll: PersonKurz;
}

/** Stufe 2: nur Vorname, genau ein Gegenstück mit Vor- und Nachname. */
export function urteilsKandidaten(personen: PersonKurz[]): Kandidat[] {
  const out: Kandidat[] = [];
  for (const x of personen) {
    if (x.tokens.length !== 1 || x.tokens[0]!.replace(/\./g, "").length < 3) continue;
    const voll = personen.filter((y) => y.id !== x.id && y.tokens.length >= 2 && y.tokens[0] === x.tokens[0]);
    if (voll.length !== 1) continue;
    if (profilWiderspruch(x, voll[0]!)) continue;
    out.push({ vorname: x, voll: voll[0]! });
  }
  return out;
}

// ---- Zusammenführen und zurücknehmen ------------------------------------------------

type Zeile = Record<string, unknown>;
interface Protokoll {
  faktenVerschoben: string[];
  faktenGeloescht: Zeile[];
  faktenInaktiv: string[];
  beobachtungen: string[];
  signale: string[];
  beschaeftigungenVerschoben: string[];
  beschaeftigungenGeloescht: Zeile[];
  quellenVerschoben: Array<{ id: string; von: string }>;
  titelVorher: Array<{ id: string; title: string | null; department: string | null }>;
  nameVorher: string;
}

const spalten = (z: Zeile) => Object.keys(z).map((k) => `"${k.replace(/"/g, "")}"`).join(", ");
const platzhalter = (z: Zeile) => Object.keys(z).map((_, i) => `$${i + 1}`).join(", ");
const werte = (z: Zeile) => Object.values(z).map((v) => (v !== null && typeof v === "object" && !(v instanceof Date) ? JSON.stringify(v) : v));

/**
 * Hängt alles von `aufloesenId` an `behaltenId` (eine Transaktion). Die aufgelöste Person
 * bleibt als leerer Datensatz stehen (ohne Fakten und Beschäftigung), damit die
 * Rücknahme sie wieder befüllen kann.
 */
export async function zusammenfuehren(
  pool: pg.Pool,
  args: { companyId: string; behaltenId: string; aufloesenId: string; regel: Regel; grund: string; actorId?: string | null },
): Promise<{ id: string; behaltenName: string; aufgeloestName: string }> {
  await ensureZusammenfuehrungSchema(pool);
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const pers = await c.query<{ id: string; fullName: string }>(`SELECT "id", "fullName" FROM "Person" WHERE "id" = ANY($1::text[]) FOR UPDATE`, [[args.behaltenId, args.aufloesenId]]);
    const B = pers.rows.find((r) => r.id === args.behaltenId);
    const A = pers.rows.find((r) => r.id === args.aufloesenId);
    if (!A || !B || A.id === B.id) throw new Error("person_nicht_gefunden");
    const prot: Protokoll = { faktenVerschoben: [], faktenGeloescht: [], faktenInaktiv: [], beobachtungen: [], signale: [], beschaeftigungenVerschoben: [], beschaeftigungenGeloescht: [], quellenVerschoben: [], titelVorher: [], nameVorher: B.fullName };

    // Fakten: verschieben, Doppelte (gleiches Feld und gleicher Wert) löschen und sichern.
    const fakten = await c.query<Zeile & { id: string; field: string; normalized: string | null; entityType: string }>(`SELECT * FROM "Fact" WHERE "personId" = $1`, [A.id]);
    for (const f of fakten.rows) {
      if (f.entityType !== "PERSON") continue;
      const doppelt = await c.query(`SELECT 1 FROM "Fact" WHERE "entityType" = 'PERSON' AND "entityId" = $1 AND "field" = $2 AND "normalized" IS NOT DISTINCT FROM $3 LIMIT 1`, [B.id, f.field, f.normalized]);
      if (doppelt.rows[0]) {
        await c.query(`DELETE FROM "Fact" WHERE "id" = $1`, [f.id]);
        prot.faktenGeloescht.push(f);
      } else {
        await c.query(`UPDATE "Fact" SET "personId" = $1, "entityId" = $1 WHERE "id" = $2`, [B.id, f.id]);
        prot.faktenVerschoben.push(f.id);
      }
    }
    // Der vollere Name gewinnt; kürzere Namensfakten werden inaktiv.
    const namen = await c.query<{ id: string; value: string }>(`SELECT "id", "value" FROM "Fact" WHERE "entityType" = 'PERSON' AND "entityId" = $1 AND "field" = 'fullName' AND "status" = 'ACTIVE'`, [B.id]);
    const voll = [A.fullName, B.fullName, ...namen.rows.map((n) => n.value)].sort((x, y) => namensTokens(y).length - namensTokens(x).length || y.length - x.length)[0]!;
    for (const n of namen.rows) {
      if (namensTokens(n.value).length < namensTokens(voll).length) {
        await c.query(`UPDATE "Fact" SET "status" = 'INACTIVE' WHERE "id" = $1`, [n.id]);
        prot.faktenInaktiv.push(n.id);
      }
    }
    if (voll !== B.fullName) await c.query(`UPDATE "Person" SET "fullName" = $1, "updatedAt" = now() WHERE "id" = $2`, [voll, B.id]);

    // Belege und Signale.
    const obs = await c.query<{ id: string }>(`UPDATE "Observation" SET "personId" = $1, "entityId" = CASE WHEN "entityType" = 'PERSON' THEN $1 ELSE "entityId" END WHERE "personId" = $2 RETURNING "id"`, [B.id, A.id]);
    prot.beobachtungen = obs.rows.map((r) => r.id);
    const sig = await c.query<{ id: string }>(`UPDATE "SignalEvent" SET "personId" = $1, "entityId" = CASE WHEN "entityType" = 'PERSON' THEN $1 ELSE "entityId" END WHERE "personId" = $2 RETURNING "id"`, [B.id, A.id]);
    prot.signale = sig.rows.map((r) => r.id);

    // Beschäftigungen: bei derselben Firma zusammenlegen, sonst umhängen.
    const besch = await c.query<Zeile & { id: string; companyId: string; title: string | null; department: string | null }>(`SELECT * FROM "Employment" WHERE "personId" = $1`, [A.id]);
    for (const e of besch.rows) {
      const ziel = await c.query<{ id: string; title: string | null; department: string | null }>(`SELECT "id", "title", "department" FROM "Employment" WHERE "personId" = $1 AND "companyId" = $2 ORDER BY "isCurrent" DESC, "lastSeen" DESC LIMIT 1`, [B.id, e.companyId]);
      const z = ziel.rows[0];
      if (z) {
        const q = await c.query<{ id: string }>(`UPDATE "EmploymentSource" SET "employmentId" = $1 WHERE "employmentId" = $2 RETURNING "id"`, [z.id, e.id]);
        prot.quellenVerschoben.push(...q.rows.map((r) => ({ id: r.id, von: e.id })));
        if ((!z.title && e.title) || (!z.department && e.department)) {
          prot.titelVorher.push({ id: z.id, title: z.title, department: z.department });
          await c.query(`UPDATE "Employment" SET "title" = COALESCE("title", $1), "department" = COALESCE("department", $2) WHERE "id" = $3`, [e.title, e.department, z.id]);
        }
        await c.query(`DELETE FROM "Employment" WHERE "id" = $1`, [e.id]);
        prot.beschaeftigungenGeloescht.push(e);
      } else {
        await c.query(`UPDATE "Employment" SET "personId" = $1 WHERE "id" = $2`, [B.id, e.id]);
        prot.beschaeftigungenVerschoben.push(e.id);
      }
    }

    const id = randomUUID();
    await c.query(
      `INSERT INTO "PersonZusammenfuehrung" ("id", "companyId", "behaltenId", "aufgeloestId", "aufgeloestName", "behaltenName", "regel", "grund", "protokoll", "actorId")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [id, args.companyId, B.id, A.id, A.fullName, voll, args.regel, args.grund.slice(0, 500), JSON.stringify(prot), args.actorId ?? null],
    );
    await c.query("COMMIT");
    return { id, behaltenName: voll, aufgeloestName: A.fullName };
  } catch (err) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

/** Nimmt eine Zusammenführung vollständig zurück. */
export async function zuruecknehmen(pool: pg.Pool, id: string): Promise<{ behaltenId: string; aufgeloestId: string } | null> {
  await ensureZusammenfuehrungSchema(pool);
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const r = await c.query<{ behaltenId: string; aufgeloestId: string; protokoll: Protokoll; rueckgaengigAt: Date | null }>(
      `SELECT "behaltenId", "aufgeloestId", "protokoll", "rueckgaengigAt" FROM "PersonZusammenfuehrung" WHERE "id" = $1 FOR UPDATE`,
      [id],
    );
    const z = r.rows[0];
    if (!z || z.rueckgaengigAt) {
      await c.query("ROLLBACK");
      return null;
    }
    const p = z.protokoll;
    const A = z.aufgeloestId, B = z.behaltenId;
    for (const e of p.beschaeftigungenGeloescht) await c.query(`INSERT INTO "Employment" (${spalten(e)}) VALUES (${platzhalter(e)})`, werte(e));
    for (const q of p.quellenVerschoben) await c.query(`UPDATE "EmploymentSource" SET "employmentId" = $1 WHERE "id" = $2`, [q.von, q.id]);
    for (const t of p.titelVorher) await c.query(`UPDATE "Employment" SET "title" = $1, "department" = $2 WHERE "id" = $3`, [t.title, t.department, t.id]);
    if (p.beschaeftigungenVerschoben.length) await c.query(`UPDATE "Employment" SET "personId" = $1 WHERE "id" = ANY($2::text[])`, [A, p.beschaeftigungenVerschoben]);
    if (p.beobachtungen.length) await c.query(`UPDATE "Observation" SET "personId" = $1, "entityId" = CASE WHEN "entityType" = 'PERSON' THEN $1 ELSE "entityId" END WHERE "id" = ANY($2::text[])`, [A, p.beobachtungen]);
    if (p.signale.length) await c.query(`UPDATE "SignalEvent" SET "personId" = $1, "entityId" = CASE WHEN "entityType" = 'PERSON' THEN $1 ELSE "entityId" END WHERE "id" = ANY($2::text[])`, [A, p.signale]);
    if (p.faktenVerschoben.length) await c.query(`UPDATE "Fact" SET "personId" = $1, "entityId" = $1 WHERE "id" = ANY($2::text[])`, [A, p.faktenVerschoben]);
    for (const f of p.faktenGeloescht) await c.query(`INSERT INTO "Fact" (${spalten(f)}) VALUES (${platzhalter(f)})`, werte(f));
    if (p.faktenInaktiv.length) await c.query(`UPDATE "Fact" SET "status" = 'ACTIVE' WHERE "id" = ANY($1::text[])`, [p.faktenInaktiv]);
    await c.query(`UPDATE "Person" SET "fullName" = $1, "updatedAt" = now() WHERE "id" = $2`, [p.nameVorher, B]);
    await c.query(`UPDATE "PersonZusammenfuehrung" SET "rueckgaengigAt" = now() WHERE "id" = $1`, [id]);
    await c.query("COMMIT");
    return { behaltenId: B, aufgeloestId: A };
  } catch (err) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}
