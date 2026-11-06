// Aktive Nutzer (Betreiber-Konsole, Joyce 2026-11-06): Der Anmeldefilter vermerkt
// je Nutzer die letzte angemeldete Anfrage, das Geraet (aus User-Agent bzw.
// x-ava-client) und die App-Version (x-ava-version). Hoechstens einmal je Minute
// und Nutzer geschrieben, damit die Tabelle nicht jede Anfrage traegt.
// "Aktiv" heisst wie bei den Desktop-Helfern: Anfrage in den letzten 15 Minuten.

import type { Pool } from "pg";

const SCHREIB_ABSTAND_MS = 60_000;
export const AKTIV_FENSTER_MIN = 15;
const zuletztGeschrieben = new Map<string, number>();

export interface AktivitaetEingang {
  actorId: string;
  tenantId: string | null;
  userAgent: string | null;
  client: string | null;
  version: string | null;
}

/** "Desktop (macOS)", "Desktop (Windows)", "Server", "App (Browser)", "MCP (Claude)" … aus Kopfzeilen ableiten. */
export function geraetAus(client: string | null, userAgent: string | null): string {
  const c = (client ?? "").trim().toLowerCase();
  if (c) {
    if (c.startsWith("desktop")) {
      if (c.includes("darwin") || c.includes("mac")) return "Desktop (macOS)";
      if (c.includes("win")) return "Desktop (Windows)";
      if (c.includes("linux")) return "Desktop (Linux)";
      return "Desktop";
    }
    if (c.startsWith("server")) return "Server";
    return c.slice(0, 40);
  }
  const ua = userAgent ?? "";
  if (/Electron/i.test(ua)) return "Desktop";
  if (/claude/i.test(ua)) return "MCP (Claude)";
  if (/chatgpt|openai/i.test(ua)) return "MCP (ChatGPT)";
  if (/Mozilla/i.test(ua)) return "App (Browser)";
  if (/node|undici/i.test(ua)) return "Dienst";
  return ua ? ua.slice(0, 40) : "unbekannt";
}

export function vermerkeAktivitaet(pool: Pool, e: AktivitaetEingang): void {
  const jetzt = Date.now();
  const letzte = zuletztGeschrieben.get(e.actorId) ?? 0;
  if (jetzt - letzte < SCHREIB_ABSTAND_MS) return;
  zuletztGeschrieben.set(e.actorId, jetzt);
  if (zuletztGeschrieben.size > 20_000) zuletztGeschrieben.clear();
  const geraet = geraetAus(e.client, e.userAgent);
  const version = (e.version ?? "").trim().slice(0, 40) || null;
  pool
    .query(
      `INSERT INTO "NutzerAktivitaet" ("actorId", "tenantId", geraet, version, "zuletztAt", anfragen, "erstesAt")
       VALUES ($1, $2, $3, $4, NOW(), 1, NOW())
       ON CONFLICT ("actorId") DO UPDATE SET "tenantId" = COALESCE(EXCLUDED."tenantId", "NutzerAktivitaet"."tenantId"), geraet = EXCLUDED.geraet,
         version = COALESCE(EXCLUDED.version, "NutzerAktivitaet".version), "zuletztAt" = NOW(), anfragen = "NutzerAktivitaet".anfragen + 1`,
      [e.actorId, e.tenantId, geraet, version],
    )
    .catch(() => undefined);
}

export interface AktiverNutzer {
  actorId: string;
  email: string | null;
  name: string | null;
  organisation: string | null;
  geraet: string;
  version: string | null;
  zuletztAt: string;
  erstesAt: string;
  anfragen: number;
  aktiv: boolean;
}

export async function aktiveNutzerListe(pool: Pool, q: { seite: number; groesse: number; nurAktiv: boolean }): Promise<{ gesamt: number; aktiv: number; seite: number; groesse: number; items: AktiverNutzer[] }> {
  const where = q.nurAktiv ? `WHERE a."zuletztAt" > NOW() - INTERVAL '${AKTIV_FENSTER_MIN} minutes'` : "";
  const [n, aktiv, rows] = await Promise.all([
    pool.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM "NutzerAktivitaet" a ${where}`),
    pool.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM "NutzerAktivitaet" a WHERE a."zuletztAt" > NOW() - INTERVAL '${AKTIV_FENSTER_MIN} minutes'`),
    pool.query<{ actorId: string; geraet: string; version: string | null; zuletztAt: Date; erstesAt: Date; anfragen: number; email: string | null; name: string | null; organisation: string | null }>(
      `SELECT a."actorId", a.geraet, a.version, a."zuletztAt", a."erstesAt", a.anfragen,
              m.email, m.name, t.name AS organisation
         FROM "NutzerAktivitaet" a
         LEFT JOIN LATERAL (
           SELECT email, name FROM "TenantMember" tm
            WHERE tm."actorId" = a."actorId"
            ORDER BY (tm."tenantId" = a."tenantId") DESC, tm."joinedAt" DESC LIMIT 1) m ON TRUE
         LEFT JOIN "Tenant" t ON t.id = a."tenantId"
         ${where}
         ORDER BY a."zuletztAt" DESC LIMIT $1 OFFSET $2`,
      [q.groesse, (q.seite - 1) * q.groesse],
    ),
  ]);
  const grenze = Date.now() - AKTIV_FENSTER_MIN * 60_000;
  return {
    gesamt: Number(n.rows[0]?.n ?? 0),
    aktiv: Number(aktiv.rows[0]?.n ?? 0),
    seite: q.seite,
    groesse: q.groesse,
    items: rows.rows.map((r) => ({
      actorId: r.actorId,
      email: r.email,
      name: r.name,
      organisation: r.organisation,
      geraet: r.geraet,
      version: r.version,
      zuletztAt: r.zuletztAt.toISOString(),
      erstesAt: r.erstesAt.toISOString(),
      anfragen: Number(r.anfragen),
      aktiv: r.zuletztAt.getTime() > grenze,
    })),
  };
}
