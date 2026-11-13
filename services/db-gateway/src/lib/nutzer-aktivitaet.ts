// Aktive Nutzer (Betreiber-Konsole, Joyce 2026-11-06): Der Anmeldefilter vermerkt
// je Nutzer die letzte angemeldete Anfrage, das Geraet (aus User-Agent bzw.
// x-ava-client) und die App-Version (x-ava-version). Hoechstens einmal je Minute
// und Nutzer geschrieben, damit die Tabelle nicht jede Anfrage traegt.
// "Aktiv" heisst wie bei den Desktop-Helfern: Anfrage in den letzten 15 Minuten.
// "anfragen" zaehlt damit Minuten mit Aktivitaet, nicht einzelne Anfragen.
// Die Durchreicher von Konsole und PWA melden sich per x-ava-client
// ("konsole" / "app"); die Konsole zaehlt nicht als Nutzung (2026-11-07: wer
// die Nutzerseite oeffnet, stand sonst selbst als "aktiv · Desktop" da).
//
// 2026-11-11 (Joyce): "zuletztAt" zaehlt jede Anfrage, auch reine Hintergrund-
// arbeit (Producer, Relais-Neuverbindung, Connector-Abfragen). "Aktiv" heisst
// seitdem: ein Mensch hat etwas angestossen (genutztAt, vermerkeNutzung) —
// Chat-Nachricht, MCP-/A2A-Werkzeugaufruf, App-Anfrage, Handlung in der App
// (Relevanz-Signal). zuletztAt bleibt als "App online". Die Version kommt
// zusaetzlich aus der Relais-Anmeldung (alte Apps senden x-ava-version nicht).

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

/** Rueckfall fuer Anfragen ohne Kennung aus Node (Hintergrunddienste der App). */
export const GERAET_SCHWACH = "Desktop";

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
    if (c === "app") return "App (Browser)";
    return c.slice(0, 40);
  }
  const ua = userAgent ?? "";
  if (/Electron/i.test(ua)) return "Desktop";
  if (/claude/i.test(ua)) return "MCP (Claude)";
  if (/chatgpt|openai/i.test(ua)) return "MCP (ChatGPT)";
  if (/Mozilla/i.test(ua)) return "App (Browser)";
  // Node ohne x-ava-client: lokale Verarbeitungsdienste der Desktop-App (oder
  // eine App vor v0.1.940). Schwache Erkennung, ueberschreibt kein bekanntes Geraet.
  if (/node|undici/i.test(ua)) return GERAET_SCHWACH;
  // Ohne Kopfzeilen kommen v. a. interne Aufrufe (Token-Pruefung der
  // Relais-Verbindung, MCP-Weiterleitung): ueberschreiben nie ein Geraet.
  return ua ? ua.slice(0, 40) : "unbekannt";
}

export function vermerkeAktivitaet(pool: Pool, e: AktivitaetEingang): void {
  if ((e.client ?? "").trim().toLowerCase() === "konsole") return;
  const jetzt = Date.now();
  const letzte = zuletztGeschrieben.get(e.actorId) ?? 0;
  if (jetzt - letzte < SCHREIB_ABSTAND_MS) return;
  zuletztGeschrieben.set(e.actorId, jetzt);
  if (zuletztGeschrieben.size > 20_000) zuletztGeschrieben.clear();
  const geraet = geraetAus(e.client, e.userAgent);
  const version = (e.version ?? "").trim().slice(0, 40) || null;
  pool
    .query(
      `INSERT INTO "NutzerAktivitaet" ("actorId", "tenantId", geraet, version, "zuletztAt", anfragen, "erstesAt", "appZuletztAt")
       VALUES ($1, $2, $3, $4, NOW(), 1, NOW(), $6)
       ON CONFLICT ("actorId") DO UPDATE SET "tenantId" = COALESCE(EXCLUDED."tenantId", "NutzerAktivitaet"."tenantId"),
         -- Burggraben 3: wann die AVA des Nutzers (Desktop/Server) zuletzt da war; Browser/MCP zaehlen nicht.
         "appZuletztAt" = COALESCE(EXCLUDED."appZuletztAt", "NutzerAktivitaet"."appZuletztAt"),
         -- Geraet = die AVA-App des Nutzers; Connector/Browser ueberschreiben sie nicht (die stehen in genutztArt).
         geraet = CASE WHEN EXCLUDED.geraet = 'unbekannt' OR (EXCLUDED.geraet = $5 AND "NutzerAktivitaet".geraet LIKE 'Desktop (%')
                         OR (EXCLUDED.geraet NOT LIKE 'Desktop%' AND EXCLUDED.geraet <> 'Server' AND ("NutzerAktivitaet".geraet LIKE 'Desktop%' OR "NutzerAktivitaet".geraet = 'Server'))
                       THEN "NutzerAktivitaet".geraet ELSE EXCLUDED.geraet END,
         version = COALESCE(EXCLUDED.version, "NutzerAktivitaet".version), "zuletztAt" = NOW(), anfragen = "NutzerAktivitaet".anfragen + 1`,
      [e.actorId, e.tenantId, geraet, version, GERAET_SCHWACH, istAppGeraet(geraet) ? new Date() : null],
    )
    .catch(() => undefined);
}

/** Desktop- oder Server-AVA (auch die schwache Node-Erkennung), nicht Browser, nicht MCP. */
export function istAppGeraet(geraet: string): boolean {
  return geraet.startsWith("Desktop") || geraet === "Server";
}

// ---- Nutzung: was ein Mensch anstoesst ---------------------------------------

const zuletztGezaehlt = new Map<string, number>();

/**
 * Handlung eines Menschen vermerken (Chat, MCP-Aufruf, App, Signal). `art` ist
 * der Text fuer die Konsole ("Chat (Telegram)", "MCP (Claude): firma_lesen").
 * nutzungMinuten zaehlt hoechstens einmal je Minute und Nutzer. Nie blockierend.
 */
export function vermerkeNutzung(pool: Pool, e: { actorId: string; tenantId: string | null; art: string; at?: Date; schwach?: boolean }): void {
  const jetzt = Date.now();
  const at = e.at && e.at.getTime() < jetzt ? e.at : new Date(jetzt);
  const letzte = zuletztGezaehlt.get(e.actorId) ?? 0;
  const zaehlen = jetzt - letzte >= SCHREIB_ABSTAND_MS;
  if (zaehlen) zuletztGezaehlt.set(e.actorId, jetzt);
  if (zuletztGezaehlt.size > 20_000) zuletztGezaehlt.clear();
  pool
    .query(
      `INSERT INTO "NutzerAktivitaet" ("actorId", "tenantId", geraet, "zuletztAt", anfragen, "erstesAt", "genutztAt", "genutztArt", "nutzungMinuten")
       VALUES ($1, $2, 'unbekannt', NOW(), 0, NOW(), $3, $4, $5)
       ON CONFLICT ("actorId") DO UPDATE SET
         -- Eine schwache Angabe ("Chat" aus dem KI-Proxy, folgt jeder Desktop-Nachricht) ersetzt
         -- keine genauere ("Chat (Desktop)") aus den letzten 10 Minuten.
         "genutztArt" = CASE WHEN $6 AND "NutzerAktivitaet"."genutztAt" > $3 - INTERVAL '10 minutes' THEN "NutzerAktivitaet"."genutztArt"
                             WHEN "NutzerAktivitaet"."genutztAt" IS NULL OR $3 >= "NutzerAktivitaet"."genutztAt" THEN $4 ELSE "NutzerAktivitaet"."genutztArt" END,
         "genutztAt" = GREATEST(COALESCE("NutzerAktivitaet"."genutztAt", $3), $3),
         "nutzungMinuten" = "NutzerAktivitaet"."nutzungMinuten" + $5`,
      [e.actorId, e.tenantId, at, e.art.slice(0, 120), zaehlen ? 1 : 0, e.schwach === true],
    )
    .catch(() => undefined);
}

/** Relais-Anmeldung der App: Version (auch von Apps, die x-ava-version noch nicht senden). */
export function vermerkeAppVersion(pool: Pool, e: { actorId: string; version: string | null }): void {
  const v = (e.version ?? "").trim().slice(0, 40);
  if (!v || v === "?") return;
  pool.query(`UPDATE "NutzerAktivitaet" SET version = $2 WHERE "actorId" = $1`, [e.actorId, v]).catch(() => undefined);
}

const SIGNAL_TEXT: Array<[RegExp, string]> = [
  [/^(firma|person)\.(chat|chatlink)$/, "Chat zu einer Firma"],
  [/^firma\.(ansicht|verweildauer)$/, "Firma angesehen"],
  [/^firma\.import$/, "Firma importiert"],
  [/^firma\.uebernommen$/, "Firma übernommen"],
  [/^(firma|person)\.crm$/, "CRM-Abgleich"],
  [/^firma\.workflow$/, "Workflow"],
  [/^(firma|person)\.watchlist$/, "Watchlist"],
  [/^person\.profil$/, "Person angesehen"],
  [/^person\.gesucht$/, "Person gesucht"],
  [/^person\.mail$/, "Mail-Entwurf"],
];
/** Relevanz-Signal ("firma.ansicht") → Text fuer die Konsole. */
export function signalText(art: string): string {
  return SIGNAL_TEXT.find(([re]) => re.test(art))?.[1] ?? "In der App";
}

/** MCP-Client aus dem User-Agent ("MCP (Claude)"), sonst "MCP". */
export function mcpClient(userAgent: string | null): string {
  const g = geraetAus(null, userAgent);
  return g.startsWith("MCP") ? g : "MCP";
}

export interface AktiverNutzer {
  actorId: string;
  email: string | null;
  name: string | null;
  organisation: string | null;
  /** AVA-App des Nutzers (Desktop/Server/App), nicht der zuletzt anfragende Connector. */
  geraet: string;
  version: string | null;
  /** Letzte Anfrage ueberhaupt (auch Hintergrund) = "App online". */
  zuletztAt: string;
  erstesAt: string;
  /** Minuten mit irgendeiner Anfrage seit erstesAt. */
  anfragen: number;
  /** Letzte Handlung eines Menschen und was es war; null = seit Erfassung keine. */
  genutztAt: string | null;
  genutztArt: string | null;
  /** Minuten mit Nutzung (seit 2026-11-11 erfasst). */
  nutzungMinuten: number;
  /** aktiv = Nutzung in den letzten 15 Minuten; online = irgendeine Anfrage darin. */
  aktiv: boolean;
  online: boolean;
  gesperrt: boolean;
  gesperrtAm: string | null;
  /** Echte Anbieterkosten (KI, Apify, Websuche) in USD. */
  kosten: { tage30: number; tage7: number; seitErfassung: number; jeMinute: number | null; monatHochrechnung: number };
}

export async function aktiveNutzerListe(pool: Pool, q: { seite: number; groesse: number; nurAktiv: boolean }): Promise<{ gesamt: number; aktiv: number; online: number; seite: number; groesse: number; neuesteVersion: string | null; items: AktiverNutzer[] }> {
  const fenster = `NOW() - INTERVAL '${AKTIV_FENSTER_MIN} minutes'`;
  const where = q.nurAktiv ? `WHERE a."genutztAt" > ${fenster}` : "";
  const { neuesteVersion } = await import("./instanz-update");
  const [n, zahl, rows, neueste] = await Promise.all([
    pool.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM "NutzerAktivitaet" a ${where}`),
    pool.query<{ aktiv: string; online: string }>(`SELECT COUNT(*) FILTER (WHERE a."genutztAt" > ${fenster})::text AS aktiv, COUNT(*) FILTER (WHERE a."zuletztAt" > ${fenster})::text AS online FROM "NutzerAktivitaet" a`),
    pool.query<{ actorId: string; geraet: string; version: string | null; zuletztAt: Date; erstesAt: Date; anfragen: number; genutztAt: Date | null; genutztArt: string | null; nutzungMinuten: number; email: string | null; name: string | null; organisation: string | null; gesperrtAm: Date | null; k30: string | null; k7: string | null; kSeit: string | null }>(
      `SELECT a."actorId", a.geraet, a.version, a."zuletztAt", a."erstesAt", a.anfragen, a."genutztAt", a."genutztArt", a."nutzungMinuten",
              m.email, m.name, t.name AS organisation, ks.am AS "gesperrtAm",
              k.k30::text, k.k7::text, k."kSeit"::text
         FROM "NutzerAktivitaet" a
         LEFT JOIN LATERAL (
           SELECT email, name FROM "TenantMember" tm
            WHERE tm."actorId" = a."actorId"
            ORDER BY (tm."tenantId" = a."tenantId") DESC, tm."joinedAt" DESC LIMIT 1) m ON TRUE
         LEFT JOIN "Tenant" t ON t.id = a."tenantId"
         LEFT JOIN "KontoStatus" ks ON ks."actorId" = a."actorId" AND ks.art = 'gesperrt'
         LEFT JOIN LATERAL (
           SELECT COALESCE(SUM(x.c) FILTER (WHERE x.at > NOW() - INTERVAL '30 days'), 0) AS k30,
                  COALESCE(SUM(x.c) FILTER (WHERE x.at > NOW() - INTERVAL '7 days'), 0) AS k7,
                  COALESCE(SUM(x.c) FILTER (WHERE x.at >= a."erstesAt"), 0) AS "kSeit"
             FROM (SELECT l."costMicroUsd" AS c, l."createdAt" AS at FROM "LlmUsage" l
                    WHERE l."actorId" = a."actorId" AND l."createdAt" > LEAST(a."erstesAt", NOW() - INTERVAL '30 days') AND l."costMicroUsd" IS NOT NULL
                   UNION ALL
                   SELECT p."kostenMicroUsd", p."createdAt" FROM "ProxyAudit" p
                    -- ueber tenantId: ProxyAudit hat keinen Index auf actorId (und bekommt keinen nachtraeglich, s. MPG-Speicher)
                    WHERE p."tenantId" = a."tenantId" AND p."actorId" = a."actorId" AND p."createdAt" > LEAST(a."erstesAt", NOW() - INTERVAL '30 days') AND p."kostenMicroUsd" IS NOT NULL) x) k ON TRUE
         ${where}
         ORDER BY a."genutztAt" DESC NULLS LAST, a."zuletztAt" DESC LIMIT $1 OFFSET $2`,
      [q.groesse, (q.seite - 1) * q.groesse],
    ),
    neuesteVersion().catch(() => null),
  ]);
  const grenze = Date.now() - AKTIV_FENSTER_MIN * 60_000;
  const usd = (micro: string | null): number => Math.round(Number(micro ?? 0) / 10_000) / 100;
  return {
    gesamt: Number(n.rows[0]?.n ?? 0),
    aktiv: Number(zahl.rows[0]?.aktiv ?? 0),
    online: Number(zahl.rows[0]?.online ?? 0),
    seite: q.seite,
    groesse: q.groesse,
    neuesteVersion: neueste,
    items: rows.rows.map((r) => {
      const seit = usd(r.kSeit);
      const minuten = Number(r.anfragen);
      return {
        actorId: r.actorId,
        email: r.email,
        name: r.name,
        organisation: r.organisation,
        geraet: r.geraet === "Dienst" ? GERAET_SCHWACH : r.geraet,
        version: r.version,
        zuletztAt: r.zuletztAt.toISOString(),
        erstesAt: r.erstesAt.toISOString(),
        anfragen: minuten,
        genutztAt: r.genutztAt ? r.genutztAt.toISOString() : null,
        genutztArt: r.genutztArt,
        nutzungMinuten: Number(r.nutzungMinuten ?? 0),
        aktiv: !!r.genutztAt && r.genutztAt.getTime() > grenze,
        online: r.zuletztAt.getTime() > grenze,
        gesperrt: !!r.gesperrtAm,
        gesperrtAm: r.gesperrtAm ? r.gesperrtAm.toISOString() : null,
        kosten: {
          tage30: usd(r.k30),
          tage7: usd(r.k7),
          seitErfassung: seit,
          // Kosten je Minute mit Aktivitaet (Hintergrund eingeschlossen: dort entstehen die meisten Kosten).
          jeMinute: minuten > 0 ? Math.round((seit / minuten) * 1000) / 1000 : null,
          monatHochrechnung: Math.round((usd(r.k7) / 7) * 30 * 100) / 100,
        },
      };
    }),
  };
}
