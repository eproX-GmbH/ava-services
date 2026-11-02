// docs/PLAN_PROBLEM_MELDEN.md M1 — Problemmeldungen: anlegen (mit Anhaengen als
// bytea), eigene lesen, antworten; Betreiber: Liste, Detail, Nachrichten (an den
// Nutzer oder intern), Status/Prioritaet/Zuweisung; Cron loescht Anhaenge 90 Tage
// nach „geschlossen“. Benachrichtigung an den Betreiber per Telegram, wenn
// OPERATOR_TELEGRAM_BOT_TOKEN und OPERATOR_TELEGRAM_CHAT_ID gesetzt sind.
import type pg from "pg";
import { randomUUID, createHash } from "node:crypto";
import { logger } from "./logger";

type Q = { query: pg.Pool["query"] };

export const KATEGORIEN = ["fehler", "daten", "verarbeitung", "anmeldung", "abrechnung", "wunsch", "sonstiges"] as const;
export type Kategorie = (typeof KATEGORIEN)[number];
export const STATUS = ["neu", "in_arbeit", "wartet_auf_nutzer", "geloest", "geschlossen", "abgelehnt"] as const;
export type Status = (typeof STATUS)[number];
export const PRIORITAETEN = ["niedrig", "normal", "hoch", "kritisch"] as const;
export type Prioritaet = (typeof PRIORITAETEN)[number];
export const QUELLEN = ["dialog", "chat", "mail", "app"] as const;

export const SNAPSHOT_MAX_BYTES = 10 * 1024 * 1024;
export const DATEI_MAX_BYTES = 5 * 1024 * 1024;
export const DATEIEN_MAX = 3;
export const AUFBEWAHRUNG_TAGE = 90;
const ERLAUBTE_MIME = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "application/pdf", "text/plain", "text/csv", "application/zip", "application/json", "text/markdown"]);

export interface Meldung {
  id: string;
  kennung: string;
  tenantId: string;
  actorId: string;
  actorName: string | null;
  actorEmail: string | null;
  kategorie: string;
  titel: string;
  beschreibung: string;
  quelle: string;
  status: string;
  prioritaet: string;
  zugewiesenAn: string | null;
  appVersion: string | null;
  plattform: string | null;
  conversationId: string | null;
  companyId: string | null;
  ungelesenNutzer: boolean;
  ungelesenBetreiber: boolean;
  letzteNutzerAntwortAt: string | null;
  letzteBetreiberAntwortAt: string | null;
  geloestAt: string | null;
  geschlossenAt: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface Anhang { id: string; art: string; dateiname: string; mime: string; groesse: number; sha256: string | null; verfuegbar: boolean; createdAt: string }
export interface Nachricht { id: string; von: string; actorId: string | null; actorName: string | null; text: string; intern: boolean; art: string; createdAt: string }

const SPALTEN = `"id", "kennung", "tenantId", "actorId", "actorName", "actorEmail", "kategorie", "titel", "beschreibung", "quelle", "status", "prioritaet", "zugewiesenAn", "appVersion", "plattform", "conversationId", "companyId", "ungelesenNutzer", "ungelesenBetreiber", "letzteNutzerAntwortAt", "letzteBetreiberAntwortAt", "geloestAt", "geschlossenAt", "createdAt", "updatedAt"`;
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
function mapMeldung(r: Record<string, unknown>): Meldung {
  return {
    id: String(r.id), kennung: String(r.kennung), tenantId: String(r.tenantId), actorId: String(r.actorId),
    actorName: (r.actorName as string | null) ?? null, actorEmail: (r.actorEmail as string | null) ?? null,
    kategorie: String(r.kategorie), titel: String(r.titel), beschreibung: String(r.beschreibung), quelle: String(r.quelle),
    status: String(r.status), prioritaet: String(r.prioritaet), zugewiesenAn: (r.zugewiesenAn as string | null) ?? null,
    appVersion: (r.appVersion as string | null) ?? null, plattform: (r.plattform as string | null) ?? null,
    conversationId: (r.conversationId as string | null) ?? null, companyId: (r.companyId as string | null) ?? null,
    ungelesenNutzer: Boolean(r.ungelesenNutzer), ungelesenBetreiber: Boolean(r.ungelesenBetreiber),
    letzteNutzerAntwortAt: iso(r.letzteNutzerAntwortAt as Date | null), letzteBetreiberAntwortAt: iso(r.letzteBetreiberAntwortAt as Date | null),
    geloestAt: iso(r.geloestAt as Date | null), geschlossenAt: iso(r.geschlossenAt as Date | null),
    createdAt: (r.createdAt as Date).toISOString(), updatedAt: (r.updatedAt as Date).toISOString(),
  };
}

async function nutzerDaten(q: Q, tenantId: string, actorId: string): Promise<{ name: string | null; email: string | null }> {
  const r = await q.query<{ name: string | null; email: string | null }>(
    `SELECT name, email FROM "TenantMembership" WHERE "tenantId" = $1 AND "actorId" = $2 LIMIT 1`, [tenantId, actorId],
  ).catch(() => ({ rows: [] as Array<{ name: string | null; email: string | null }> }));
  return { name: r.rows[0]?.name ?? null, email: r.rows[0]?.email ?? null };
}

export interface NeueDatei { feld: "snapshot" | "datei"; name: string; mime: string; bytes: Uint8Array }

/** Dateien pruefen: Snapshot (ZIP) bis 10 MB, bis zu 3 weitere Dateien je 5 MB, nur bekannte Typen. */
export function dateienPruefen(dateien: NeueDatei[]): string | null {
  const snapshots = dateien.filter((d) => d.feld === "snapshot");
  const weitere = dateien.filter((d) => d.feld === "datei");
  if (snapshots.length > 1) return "Nur eine Protokoll-Datei je Meldung.";
  if (snapshots[0] && snapshots[0].bytes.byteLength > SNAPSHOT_MAX_BYTES) return `Die Protokoll-Datei ist groesser als ${SNAPSHOT_MAX_BYTES / 1024 / 1024} MB.`;
  if (weitere.length > DATEIEN_MAX) return `Hoechstens ${DATEIEN_MAX} Dateien je Meldung.`;
  for (const d of weitere) {
    if (d.bytes.byteLength > DATEI_MAX_BYTES) return `„${d.name}“ ist groesser als ${DATEI_MAX_BYTES / 1024 / 1024} MB.`;
    if (!ERLAUBTE_MIME.has(d.mime)) return `„${d.name}“: Dateityp ${d.mime} wird nicht angenommen (Bilder, PDF, Text).`;
  }
  return null;
}

async function anhangSpeichern(q: Q, meldungId: string, d: NeueDatei): Promise<void> {
  const art = d.feld === "snapshot" ? "snapshot" : d.mime.startsWith("image/") ? "bild" : "dokument";
  const sha = createHash("sha256").update(d.bytes).digest("hex");
  await q.query(
    `INSERT INTO "ProblemAnhang" ("id", "meldungId", art, dateiname, mime, groesse, sha256, inhalt) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [randomUUID(), meldungId, art, d.name.slice(0, 200), d.mime, d.bytes.byteLength, sha, Buffer.from(d.bytes)],
  );
}

export async function meldungAnlegen(
  pool: pg.Pool,
  input: { tenantId: string; actorId: string; kategorie: string; titel: string; beschreibung: string; quelle: string; appVersion?: string | null; plattform?: string | null; conversationId?: string | null; companyId?: string | null; dateien: NeueDatei[] },
): Promise<Meldung> {
  const fehler = dateienPruefen(input.dateien);
  if (fehler) throw Object.assign(new Error(fehler), { status: 413 });
  const nutzer = await nutzerDaten(pool, input.tenantId, input.actorId);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const nr = await client.query<{ n: string }>(`SELECT nextval('"ProblemMeldung_nr_seq"')::text AS n`);
    const kennung = `PM-${new Date().getUTCFullYear()}-${String(Number(nr.rows[0]?.n ?? 1)).padStart(4, "0")}`;
    const id = randomUUID();
    const r = await client.query(
      `INSERT INTO "ProblemMeldung" ("id", "kennung", "tenantId", "actorId", "actorName", "actorEmail", "kategorie", "titel", "beschreibung", "quelle", "appVersion", "plattform", "conversationId", "companyId")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING ${SPALTEN}`,
      [id, kennung, input.tenantId, input.actorId, nutzer.name, nutzer.email, input.kategorie, input.titel.slice(0, 120), input.beschreibung.slice(0, 8000), input.quelle, input.appVersion ?? null, input.plattform ?? null, input.conversationId ?? null, input.companyId ?? null],
    );
    for (const d of input.dateien) await anhangSpeichern(client, id, d);
    await client.query(`INSERT INTO "ProblemNachricht" ("id", "meldungId", von, "actorId", "actorName", text, intern, art) VALUES ($1, $2, 'system', NULL, NULL, $3, FALSE, 'status')`, [randomUUID(), id, "Meldung eingegangen"]);
    await client.query("COMMIT");
    const m = mapMeldung(r.rows[0] as Record<string, unknown>);
    void betreiberBenachrichtigen(`Neue Problemmeldung ${m.kennung} (${m.kategorie}): ${m.titel}\nvon ${m.actorName ?? m.actorEmail ?? m.actorId}${m.appVersion ? `, AVA ${m.appVersion}` : ""}${m.plattform ? ` (${m.plattform})` : ""}`);
    return m;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function meineMeldungen(q: Q, actorId: string): Promise<Array<Meldung & { letzteNachricht: string | null; nachrichten: number }>> {
  const r = await q.query(
    `SELECT m.*, (SELECT text FROM "ProblemNachricht" n WHERE n."meldungId" = m.id AND NOT n.intern AND n.art = 'nachricht' ORDER BY n."createdAt" DESC LIMIT 1) AS "letzteNachricht",
            (SELECT COUNT(*)::int FROM "ProblemNachricht" n WHERE n."meldungId" = m.id AND NOT n.intern) AS nachrichten
       FROM "ProblemMeldung" m WHERE m."actorId" = $1 ORDER BY m."updatedAt" DESC LIMIT 200`,
    [actorId],
  );
  return r.rows.map((row) => ({ ...mapMeldung(row as Record<string, unknown>), letzteNachricht: ((row as Record<string, unknown>).letzteNachricht as string | null) ?? null, nachrichten: Number((row as Record<string, unknown>).nachrichten ?? 0) }));
}

export async function meldungLesen(q: Q, id: string, opts: { actorId?: string; betreiber?: boolean }): Promise<{ meldung: Meldung; anhaenge: Anhang[]; nachrichten: Nachricht[] } | null> {
  const r = await q.query(`SELECT ${SPALTEN} FROM "ProblemMeldung" WHERE id = $1 OR kennung = $1 LIMIT 1`, [id]);
  const row = r.rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  const meldung = mapMeldung(row);
  if (!opts.betreiber && meldung.actorId !== opts.actorId) return null;
  const a = await q.query<{ id: string; art: string; dateiname: string; mime: string; groesse: number; sha256: string | null; geloeschtAt: Date | null; createdAt: Date }>(
    `SELECT id, art, dateiname, mime, groesse, sha256, "geloeschtAt", "createdAt" FROM "ProblemAnhang" WHERE "meldungId" = $1 ORDER BY "createdAt"`, [meldung.id],
  );
  const n = await q.query<{ id: string; von: string; actorId: string | null; actorName: string | null; text: string; intern: boolean; art: string; createdAt: Date }>(
    `SELECT id, von, "actorId", "actorName", text, intern, art, "createdAt" FROM "ProblemNachricht" WHERE "meldungId" = $1 ${opts.betreiber ? "" : "AND NOT intern"} ORDER BY "createdAt"`, [meldung.id],
  );
  return {
    meldung,
    anhaenge: a.rows.map((x) => ({ id: x.id, art: x.art, dateiname: x.dateiname, mime: x.mime, groesse: x.groesse, sha256: x.sha256, verfuegbar: !x.geloeschtAt, createdAt: x.createdAt.toISOString() })),
    nachrichten: n.rows.map((x) => ({ id: x.id, von: x.von, actorId: x.actorId, actorName: x.actorName, text: x.text, intern: x.intern, art: x.art, createdAt: x.createdAt.toISOString() })),
  };
}

export async function anhangLaden(q: Q, meldungId: string, anhangId: string): Promise<{ dateiname: string; mime: string; inhalt: Buffer } | null> {
  const r = await q.query<{ dateiname: string; mime: string; inhalt: Buffer | null }>(`SELECT dateiname, mime, inhalt FROM "ProblemAnhang" WHERE id = $1 AND "meldungId" = $2`, [anhangId, meldungId]);
  const x = r.rows[0];
  if (!x || !x.inhalt) return null;
  return { dateiname: x.dateiname, mime: x.mime, inhalt: x.inhalt };
}

export async function anhaengeNachreichen(pool: pg.Pool, meldungId: string, dateien: NeueDatei[]): Promise<number> {
  const vorhanden = await pool.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM "ProblemAnhang" WHERE "meldungId" = $1 AND art <> 'snapshot'`, [meldungId]);
  const weitere = dateien.filter((d) => d.feld === "datei");
  if (Number(vorhanden.rows[0]?.n ?? 0) + weitere.length > DATEIEN_MAX) throw Object.assign(new Error(`Hoechstens ${DATEIEN_MAX} Dateien je Meldung.`), { status: 413 });
  const fehler = dateienPruefen(dateien);
  if (fehler) throw Object.assign(new Error(fehler), { status: 413 });
  for (const d of dateien) await anhangSpeichern(pool, meldungId, d);
  await pool.query(`UPDATE "ProblemMeldung" SET "ungelesenBetreiber" = TRUE, "updatedAt" = NOW() WHERE id = $1`, [meldungId]);
  return dateien.length;
}

/** Antwort des Nutzers: Status „wartet auf Nutzer“ geht zurueck auf „in Arbeit“. */
export async function nutzerAntwort(q: Q, meldung: Meldung, text: string): Promise<Nachricht> {
  const id = randomUUID();
  await q.query(`INSERT INTO "ProblemNachricht" ("id", "meldungId", von, "actorId", "actorName", text, intern, art) VALUES ($1, $2, 'nutzer', $3, $4, $5, FALSE, 'nachricht')`, [id, meldung.id, meldung.actorId, meldung.actorName, text.slice(0, 8000)]);
  const neuerStatus = meldung.status === "wartet_auf_nutzer" ? "in_arbeit" : meldung.status === "geloest" || meldung.status === "geschlossen" ? "in_arbeit" : meldung.status;
  await q.query(`UPDATE "ProblemMeldung" SET status = $2, "ungelesenBetreiber" = TRUE, "letzteNutzerAntwortAt" = NOW(), "updatedAt" = NOW(), "geloestAt" = CASE WHEN $2 = 'in_arbeit' THEN NULL ELSE "geloestAt" END WHERE id = $1`, [meldung.id, neuerStatus]);
  void betreiberBenachrichtigen(`Antwort zu ${meldung.kennung} von ${meldung.actorName ?? meldung.actorEmail ?? meldung.actorId}: ${text.slice(0, 300)}`);
  return { id, von: "nutzer", actorId: meldung.actorId, actorName: meldung.actorName, text, intern: false, art: "nachricht", createdAt: new Date().toISOString() };
}

export async function nutzerGelesen(q: Q, meldungId: string): Promise<void> {
  await q.query(`UPDATE "ProblemMeldung" SET "ungelesenNutzer" = FALSE WHERE id = $1`, [meldungId]);
}

// ---- Betreiber -------------------------------------------------------------

export interface ListeFilter { status?: string; prioritaet?: string; kategorie?: string; zugewiesenAn?: string; tenantId?: string; suche?: string; offen?: boolean }

export async function betreiberListe(q: Q, f: ListeFilter): Promise<{ meldungen: Array<Meldung & { orgName: string | null; anhaenge: number }>; zaehler: Record<string, number>; ungelesen: number }> {
  const bed: string[] = [];
  const par: unknown[] = [];
  const add = (sql: string, v: unknown) => { par.push(v); bed.push(sql.replace("?", `$${par.length}`)); };
  if (f.status) add(`m.status = ?`, f.status);
  else if (f.offen) bed.push(`m.status IN ('neu', 'in_arbeit', 'wartet_auf_nutzer')`);
  if (f.prioritaet) add(`m.prioritaet = ?`, f.prioritaet);
  if (f.kategorie) add(`m.kategorie = ?`, f.kategorie);
  if (f.zugewiesenAn) add(`m."zugewiesenAn" = ?`, f.zugewiesenAn);
  if (f.tenantId) add(`m."tenantId" = ?`, f.tenantId);
  if (f.suche) add(`(m.titel ILIKE ? OR m.beschreibung ILIKE $${par.length + 1} OR m.kennung ILIKE $${par.length + 1} OR m."actorEmail" ILIKE $${par.length + 1})`, `%${f.suche}%`);
  const where = bed.length > 0 ? `WHERE ${bed.join(" AND ")}` : "";
  const r = await q.query(
    `SELECT m.*, t.name AS "orgName", (SELECT COUNT(*)::int FROM "ProblemAnhang" a WHERE a."meldungId" = m.id) AS anhaenge
       FROM "ProblemMeldung" m LEFT JOIN "Tenant" t ON t.id = m."tenantId" ${where}
      ORDER BY CASE m.prioritaet WHEN 'kritisch' THEN 0 WHEN 'hoch' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, m."updatedAt" DESC LIMIT 500`,
    par,
  );
  const z = await q.query<{ status: string; n: string }>(`SELECT status, COUNT(*)::text AS n FROM "ProblemMeldung" GROUP BY status`);
  const u = await q.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM "ProblemMeldung" WHERE "ungelesenBetreiber"`);
  const zaehler: Record<string, number> = {};
  for (const row of z.rows) zaehler[row.status] = Number(row.n);
  return {
    meldungen: r.rows.map((row) => ({ ...mapMeldung(row as Record<string, unknown>), orgName: ((row as Record<string, unknown>).orgName as string | null) ?? null, anhaenge: Number((row as Record<string, unknown>).anhaenge ?? 0) })),
    zaehler,
    ungelesen: Number(u.rows[0]?.n ?? 0),
  };
}

export async function betreiberNachricht(q: Q, meldung: Meldung, betreiber: { actorId: string; name: string | null }, text: string, intern: boolean): Promise<Nachricht> {
  const id = randomUUID();
  await q.query(`INSERT INTO "ProblemNachricht" ("id", "meldungId", von, "actorId", "actorName", text, intern, art) VALUES ($1, $2, 'betreiber', $3, $4, $5, $6, 'nachricht')`, [id, meldung.id, betreiber.actorId, betreiber.name, text.slice(0, 8000), intern]);
  if (!intern) {
    await q.query(`UPDATE "ProblemMeldung" SET "ungelesenNutzer" = TRUE, "ungelesenBetreiber" = FALSE, "letzteBetreiberAntwortAt" = NOW(), status = CASE WHEN status = 'neu' THEN 'in_arbeit' ELSE status END, "updatedAt" = NOW() WHERE id = $1`, [meldung.id]);
  } else {
    await q.query(`UPDATE "ProblemMeldung" SET "updatedAt" = NOW() WHERE id = $1`, [meldung.id]);
  }
  return { id, von: "betreiber", actorId: betreiber.actorId, actorName: betreiber.name, text, intern, art: "nachricht", createdAt: new Date().toISOString() };
}

const STATUS_TEXT: Record<string, string> = { neu: "neu", in_arbeit: "in Arbeit", wartet_auf_nutzer: "wartet auf Nutzer", geloest: "gelöst", geschlossen: "geschlossen", abgelehnt: "abgelehnt" };

export async function betreiberAendern(q: Q, meldung: Meldung, betreiber: { actorId: string; name: string | null }, aenderung: { status?: Status; prioritaet?: Prioritaet; zugewiesenAn?: string | null; kategorie?: Kategorie }): Promise<Meldung> {
  const sets: string[] = [];
  const par: unknown[] = [meldung.id];
  const notiz = async (art: string, text: string) => {
    await q.query(`INSERT INTO "ProblemNachricht" ("id", "meldungId", von, "actorId", "actorName", text, intern, art) VALUES ($1, $2, 'system', $3, $4, $5, FALSE, $6)`, [randomUUID(), meldung.id, betreiber.actorId, betreiber.name, text, art]);
  };
  if (aenderung.status && aenderung.status !== meldung.status) {
    par.push(aenderung.status); sets.push(`status = $${par.length}`);
    if (aenderung.status === "geloest") sets.push(`"geloestAt" = NOW()`);
    if (aenderung.status === "geschlossen" || aenderung.status === "abgelehnt") sets.push(`"geschlossenAt" = NOW()`);
    if (aenderung.status === "in_arbeit" || aenderung.status === "neu") sets.push(`"geloestAt" = NULL, "geschlossenAt" = NULL`);
    sets.push(`"ungelesenNutzer" = TRUE`);
    await notiz("status", `Status: ${STATUS_TEXT[aenderung.status] ?? aenderung.status}${betreiber.name ? ` (${betreiber.name})` : ""}`);
  }
  if (aenderung.prioritaet && aenderung.prioritaet !== meldung.prioritaet) {
    par.push(aenderung.prioritaet); sets.push(`prioritaet = $${par.length}`);
    await notiz("prioritaet", `Priorität: ${aenderung.prioritaet}`);
  }
  if (aenderung.zugewiesenAn !== undefined && aenderung.zugewiesenAn !== meldung.zugewiesenAn) {
    par.push(aenderung.zugewiesenAn); sets.push(`"zugewiesenAn" = $${par.length}`);
    await notiz("zuweisung", aenderung.zugewiesenAn ? `Zugewiesen an ${aenderung.zugewiesenAn}` : "Zuweisung entfernt");
  }
  if (aenderung.kategorie && aenderung.kategorie !== meldung.kategorie) {
    par.push(aenderung.kategorie); sets.push(`kategorie = $${par.length}`);
  }
  if (sets.length === 0) return meldung;
  sets.push(`"updatedAt" = NOW()`);
  const r = await q.query(`UPDATE "ProblemMeldung" SET ${sets.join(", ")} WHERE id = $1 RETURNING ${SPALTEN}`, par);
  return mapMeldung(r.rows[0] as Record<string, unknown>);
}

export async function betreiberGelesen(q: Q, meldungId: string): Promise<void> {
  await q.query(`UPDATE "ProblemMeldung" SET "ungelesenBetreiber" = FALSE WHERE id = $1`, [meldungId]);
}

/** Cron: Anhaenge 90 Tage nach geschlossen/abgelehnt leeren (Zeile bleibt als Nachweis). */
export async function anhaengeAufraeumen(q: Q): Promise<number> {
  const r = await q.query(
    `UPDATE "ProblemAnhang" a SET inhalt = NULL, "geloeschtAt" = NOW()
       FROM "ProblemMeldung" m
      WHERE a."meldungId" = m.id AND a.inhalt IS NOT NULL AND m."geschlossenAt" IS NOT NULL AND m."geschlossenAt" < NOW() - ($1 || ' days')::interval`,
    [String(AUFBEWAHRUNG_TAGE)],
  );
  return r.rowCount ?? 0;
}

/** Telegram an den Betreiber (optional, Fly-Secrets OPERATOR_TELEGRAM_BOT_TOKEN / OPERATOR_TELEGRAM_CHAT_ID). */
export async function betreiberBenachrichtigen(text: string): Promise<boolean> {
  const token = process.env.OPERATOR_TELEGRAM_BOT_TOKEN;
  const chatId = process.env.OPERATOR_TELEGRAM_CHAT_ID;
  if (!token || !chatId) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 3500), disable_web_page_preview: true }),
    });
    if (!res.ok) logger.warn({ status: res.status }, "[problem] Telegram-Benachrichtigung fehlgeschlagen");
    return res.ok;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "[problem] Telegram nicht erreichbar");
    return false;
  }
}
