// Firmenlogos (docs/PLAN_FIRMENLOGOS.md, LG2): Annahme aus dem Persist-Ereignis der Website-
// Stufe, Ablage im Objektspeicher, Angaben in der Website-Datenbank, Auslieferung.
//
// Die Website-Stufe laeuft auf dem Geraet des Nutzers; was sie schickt, ist fremde Eingabe.
// Deshalb prueft das Gateway jedes Bild selbst: Bildart aus den Bytes (nicht aus der
// Angabe), Obergrenze, kein aktives SVG, Pruefsumme selbst gerechnet. Der Schluessel im
// Speicher ist der SHA-256 des Inhalts (`logos/<sha256>.<endung>`): gleiche Bilder liegen
// einmal, und eine Adresse zeigt fuer immer auf denselben Inhalt.

import type pg from "pg";
import { createHash } from "node:crypto";
import { getProducerPool } from "./producer-pools";
import { objektAblegen, objektHolen, objektVorhanden, objektspeicherAktiv } from "./objektspeicher";

export type LogoRolle = "zeichen" | "wortmarke";

export const LOGO_MAX_BYTES = 256_000;
const MIN_BYTES = 70;
const ENDUNG: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/x-icon": "ico", "image/svg+xml": "svg" };
const STUFEN = new Set(["manifest", "apple", "icon", "jsonld", "kopf", "og", "favicon", "nutzer"]);

/** Bildart aus den ersten Bytes; null bei allem anderen (HTML-Fehlerseite, Unsinn). */
export function bildMime(buf: Buffer): string | null {
  if (buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47) return "image/png";
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length > 6 && buf.toString("ascii", 0, 3) === "GIF") return "image/gif";
  if (buf.length > 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (buf.length > 6 && buf.readUInt16LE(0) === 0 && buf.readUInt16LE(2) === 1 && buf.readUInt16LE(4) > 0 && buf.readUInt16LE(4) <= 64) return "image/x-icon";
  if (/<svg[\s>]/i.test(buf.toString("utf8", 0, Math.min(buf.length, 8000)))) return "image/svg+xml";
  return null;
}

/** Aktive Inhalte in einem SVG? Die Website-Stufe bereinigt schon; hier wird nur noch abgelehnt. */
export function svgIstAktiv(text: string): boolean {
  return /<script[\s>]|<foreignObject[\s>]|<iframe[\s>]|javascript:|[\s"']on[a-z]+\s*=/i.test(text);
}

export interface LogoGeprueft {
  rolle: LogoRolle;
  mime: string;
  breite: number;
  hoehe: number;
  stufe: string;
  quelleUrl: string | null;
  klein: boolean;
  inhalt: Buffer;
  sha256: string;
}

export function logoPruefen(roh: unknown): LogoGeprueft | { fehler: string } {
  if (!roh || typeof roh !== "object") return { fehler: "kein Objekt" };
  const r = roh as Record<string, unknown>;
  if (r.rolle !== "zeichen" && r.rolle !== "wortmarke") return { fehler: "unbekannte Rolle" };
  if (typeof r.inhaltBase64 !== "string" || r.inhaltBase64.length === 0) return { fehler: "ohne Inhalt" };
  // Base64 ist ein Drittel groesser als die Bytes; vor dem Dekodieren begrenzen.
  if (r.inhaltBase64.length > Math.ceil(LOGO_MAX_BYTES / 3) * 4 + 8) return { fehler: "zu gross" };
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(r.inhaltBase64)) return { fehler: "kein Base64" };
  const inhalt = Buffer.from(r.inhaltBase64, "base64");
  if (inhalt.length < MIN_BYTES || inhalt.length > LOGO_MAX_BYTES) return { fehler: "Groesse ausserhalb der Grenzen" };
  const mime = bildMime(inhalt);
  if (!mime) return { fehler: "keine erlaubte Bildart" };
  if (mime === "image/svg+xml" && svgIstAktiv(inhalt.toString("utf8"))) return { fehler: "SVG mit aktivem Inhalt" };
  const zahl = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 20_000 ? Math.round(v) : 0);
  const stufe = typeof r.stufe === "string" && STUFEN.has(r.stufe) ? r.stufe : "kopf";
  const quelleUrl = typeof r.quelleUrl === "string" && /^https?:\/\//i.test(r.quelleUrl) ? r.quelleUrl.slice(0, 1000) : null;
  return {
    rolle: r.rolle,
    mime,
    breite: zahl(r.breite),
    hoehe: zahl(r.hoehe),
    stufe,
    quelleUrl,
    klein: r.klein === true,
    inhalt,
    sha256: createHash("sha256").update(inhalt).digest("hex"),
  };
}

export const logoSchluessel = (sha256: string, mime: string): string => `logos/${sha256}.${ENDUNG[mime] ?? "bin"}`;

type Abfrage = Pick<pg.Pool, "query">;

let bereit = false;
async function sicherstellen(pool: Abfrage): Promise<void> {
  if (bereit) return;
  // Neue, kleine Tabelle in der Website-Datenbank (eine Zeile je Firma und Rolle); der Index
  // traegt die Auslieferung nach Pruefsumme. Kein Eingriff in bestehende Tabellen.
  await pool.query(`CREATE TABLE IF NOT EXISTS "CompanyLogo" (
    "companyId"  TEXT NOT NULL,
    rolle        TEXT NOT NULL,
    sha256       TEXT NOT NULL,
    mime         TEXT NOT NULL,
    breite       INTEGER NOT NULL DEFAULT 0,
    hoehe        INTEGER NOT NULL DEFAULT 0,
    bytes        INTEGER NOT NULL,
    stufe        TEXT NOT NULL,
    "quelleUrl"  TEXT,
    klein        BOOLEAN NOT NULL DEFAULT FALSE,
    "geprueftAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "createdAt"  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt"  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY ("companyId", rolle)
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS "CompanyLogo_sha256_idx" ON "CompanyLogo" (sha256)`);
  bereit = true;
}

/** Nur fuer Tests. */
export function logosZuruecksetzen(): void {
  bereit = false;
}

export interface LogoSpeicher {
  aktiv(): boolean;
  vorhanden(schluessel: string): Promise<boolean>;
  ablegen(schluessel: string, inhalt: Buffer, mime: string): Promise<void>;
  holen(schluessel: string): Promise<{ inhalt: Buffer; mime: string | null } | null>;
}

const echterSpeicher: LogoSpeicher = { aktiv: objektspeicherAktiv, vorhanden: objektVorhanden, ablegen: objektAblegen, holen: objektHolen };

/**
 * Logos einer Firma uebernehmen: je Rolle hoechstens eines, erst in den Speicher, dann die
 * Zeile. Fehlt eine Rolle im Ereignis, bleibt das bisherige Logo stehen (ein gescheiterter
 * Abruf auf dem Geraet soll kein vorhandenes Logo loeschen).
 */
export async function logosUebernehmen(
  companyId: string,
  logos: unknown,
  opt: { pool?: Abfrage; speicher?: LogoSpeicher } = {},
): Promise<{ gespeichert: LogoRolle[]; verworfen: string[]; ruht: boolean }> {
  const speicher = opt.speicher ?? echterSpeicher;
  if (!speicher.aktiv()) return { gespeichert: [], verworfen: [], ruht: true };
  const liste = Array.isArray(logos) ? logos.slice(0, 4) : [];
  if (liste.length === 0) return { gespeichert: [], verworfen: [], ruht: false };
  const pool = opt.pool ?? getProducerPool("website");
  await sicherstellen(pool);
  const gespeichert: LogoRolle[] = [];
  const verworfen: string[] = [];
  for (const roh of liste) {
    const l = logoPruefen(roh);
    if ("fehler" in l) {
      verworfen.push(l.fehler);
      continue;
    }
    if (gespeichert.includes(l.rolle)) continue;
    const schluessel = logoSchluessel(l.sha256, l.mime);
    if (!(await speicher.vorhanden(schluessel))) await speicher.ablegen(schluessel, l.inhalt, l.mime);
    await pool.query(
      `INSERT INTO "CompanyLogo" ("companyId", rolle, sha256, mime, breite, hoehe, bytes, stufe, "quelleUrl", klein, "geprueftAt", "updatedAt")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, NOW(), NOW())
       ON CONFLICT ("companyId", rolle) DO UPDATE SET
         sha256 = EXCLUDED.sha256, mime = EXCLUDED.mime, breite = EXCLUDED.breite, hoehe = EXCLUDED.hoehe, bytes = EXCLUDED.bytes,
         stufe = EXCLUDED.stufe, "quelleUrl" = EXCLUDED."quelleUrl", klein = EXCLUDED.klein, "geprueftAt" = NOW(),
         "updatedAt" = CASE WHEN "CompanyLogo".sha256 = EXCLUDED.sha256 THEN "CompanyLogo"."updatedAt" ELSE NOW() END`,
      [companyId, l.rolle, l.sha256, l.mime, l.breite, l.hoehe, l.inhalt.length, l.stufe, l.quelleUrl, l.klein],
    );
    gespeichert.push(l.rolle);
  }
  return { gespeichert, verworfen, ruht: false };
}

export interface LogoAngabe {
  sha256: string;
  mime: string;
  breite: number;
  hoehe: number;
  klein: boolean;
  stufe: string;
}

export type FirmenLogos = Partial<Record<LogoRolle, LogoAngabe>>;

/** Logos mehrerer Firmen (fuer Firmendaten und Listen); ohne Tabelle oder ohne Treffer leer. */
export async function logosLesen(companyIds: string[], pool: Abfrage = getProducerPool("website")): Promise<Map<string, FirmenLogos>> {
  const out = new Map<string, FirmenLogos>();
  const ids = [...new Set(companyIds.filter(Boolean))].slice(0, 500);
  if (ids.length === 0) return out;
  let rows: Array<{ companyId: string; rolle: string; sha256: string; mime: string; breite: number; hoehe: number; klein: boolean; stufe: string }>;
  try {
    const r = await pool.query(`SELECT "companyId", rolle, sha256, mime, breite, hoehe, klein, stufe FROM "CompanyLogo" WHERE "companyId" = ANY($1::text[])`, [ids]);
    rows = r.rows as typeof rows;
  } catch (err) {
    // Tabelle entsteht erst mit dem ersten Logo (42P01 = gibt es noch nicht).
    if ((err as { code?: string }).code === "42P01") return out;
    throw err;
  }
  for (const z of rows) {
    if (z.rolle !== "zeichen" && z.rolle !== "wortmarke") continue;
    const f = out.get(z.companyId) ?? {};
    f[z.rolle] = { sha256: z.sha256, mime: z.mime, breite: z.breite, hoehe: z.hoehe, klein: z.klein, stufe: z.stufe };
    out.set(z.companyId, f);
  }
  return out;
}

/**
 * Bild zu einer Pruefsumme. Nur was als Logo einer Firma eingetragen ist, wird ausgeliefert:
 * Die Route ist kein allgemeiner Zugang zum Bucket.
 */
export async function logoInhalt(sha256: string, opt: { pool?: Abfrage; speicher?: LogoSpeicher } = {}): Promise<{ inhalt: Buffer; mime: string } | null> {
  if (!/^[0-9a-f]{64}$/.test(sha256)) return null;
  const speicher = opt.speicher ?? echterSpeicher;
  if (!speicher.aktiv()) return null;
  const pool = opt.pool ?? getProducerPool("website");
  let mime: string | undefined;
  try {
    const r = await pool.query<{ mime: string }>(`SELECT mime FROM "CompanyLogo" WHERE sha256 = $1 LIMIT 1`, [sha256]);
    mime = r.rows[0]?.mime;
  } catch (err) {
    if ((err as { code?: string }).code === "42P01") return null;
    throw err;
  }
  if (!mime || !ENDUNG[mime]) return null;
  const o = await speicher.holen(logoSchluessel(sha256, mime));
  return o ? { inhalt: o.inhalt, mime } : null;
}
