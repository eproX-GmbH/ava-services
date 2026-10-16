// Vorabanalyse: Valueserp-Suche aus dem Gateway (Betreiber-Schluessel), je Aufruf eine
// ProxyAudit-Zeile mit Tarif, Preis und Lauf-Kennung (ref), damit Kosten je Lauf stimmen.

import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { loadEnv } from "../env";
import { valueserpTarif } from "../anbieter-kosten";
import { istPlattform, kernDomain } from "./crawl";

export interface Treffer { index: number; title: string; link: string; domain: string; snippet: string }

/** Suche mit bis zu drei Versuchen: Valueserp antwortet unter Last langsam (20-50 s) oder
 *  mit leerer Trefferliste; Zeitueberschreitung und leere Antwort werden wiederholt. */
export async function valueserpSucheMitWiederholung(pool: Pool, q: string, ref: string, num = 8): Promise<{ treffer: Treffer[]; status: number; versuche: number }> {
  let letzter: unknown = null;
  for (let versuch = 1; versuch <= 3; versuch++) {
    try {
      const r = await valueserpSuche(pool, q, ref, num, 90_000);
      if (r.treffer.length > 0 || versuch === 3) return { ...r, versuche: versuch };
    } catch (err) {
      letzter = err;
      if (versuch === 3) throw err;
    }
    await new Promise((res) => setTimeout(res, 3_000 * versuch));
  }
  throw letzter instanceof Error ? letzter : new Error("Suche fehlgeschlagen");
}

export async function valueserpSuche(pool: Pool, q: string, ref: string, num = 8, timeoutMs = 90_000): Promise<{ treffer: Treffer[]; status: number }> {
  const env = loadEnv();
  if (!env.VALUESERP_API_KEY) throw new Error("VALUESERP_API_KEY fehlt");
  const params = new URLSearchParams();
  params.set("api_key", env.VALUESERP_API_KEY);
  params.set("q", q);
  params.set("engine", "google");
  params.set("location_auto", "false");
  params.set("google_domain", env.VALUESERP_DOMAIN ?? "google.de");
  params.set("hl", env.VALUESERP_UI_LANGUAGE ?? "de");
  params.set("gl", env.VALUESERP_LOCATION ?? "de");
  params.set("num", String(num));
  const start = Date.now();
  let status = 0;
  let json: { organic_results?: Array<{ title?: string; link?: string; domain?: string; snippet?: string }> } = {};
  try {
    const res = await fetch(`https://api.valueserp.com/search?${params.toString()}`, { signal: AbortSignal.timeout(timeoutMs) });
    status = res.status;
    json = (await res.json().catch(() => ({}))) as typeof json;
  } catch (err) {
    status = 599;
    throw err;
  } finally {
    const t = valueserpTarif();
    const kosten = status >= 200 && status < 400 ? t.preisMicroUsd : 0;
    void pool.query(
      `INSERT INTO "ProxyAudit" (proxy, "tenantId", "actorId", "qHash", status, "latencyMs", "cacheHit", "tarif", "kostenMicroUsd", "ref", "createdAt") VALUES ('valueserp', $1, 'vorabanalyse', $2, $3, $4, false, $5, $6, $7, NOW())`,
      [process.env.OPERATOR_TENANT_ID ?? "betreiber", createHash("sha256").update(q).digest("hex"), status, Date.now() - start, t.name, kosten, ref],
    ).catch(() => undefined);
  }
  if (status >= 400) throw new Error(`Valueserp ${status}`);
  const treffer: Treffer[] = [];
  for (const o of json.organic_results ?? []) {
    const link = echterLink(o.link, o.domain);
    if (!link) continue;
    let host = "";
    try { host = new URL(link).hostname; } catch { continue; }
    treffer.push({ index: treffer.length, title: (o.title ?? "").slice(0, 200), link, domain: kernDomain(host), snippet: (o.snippet ?? "").slice(0, 300) });
  }
  return { treffer, status };
}

/** Valueserp liefert Links teils als Google-Weiterleitung (google.com/url?q=…): Ziel
 *  aus dem Parameter lesen; sonst das Domain-Feld der Antwort als Rueckfall. */
export function echterLink(link: string | undefined, domain: string | undefined): string | null {
  if (link) {
    try {
      const u = new URL(link);
      if (/(^|\.)google\.[a-z.]+$/i.test(u.hostname) && (u.pathname === "/url" || u.pathname.startsWith("/url"))) {
        const ziel = u.searchParams.get("q") ?? u.searchParams.get("url");
        if (ziel && /^https?:\/\//i.test(ziel)) return ziel;
      } else {
        return link;
      }
    } catch { /* unten */ }
  }
  const d = (domain ?? "").trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
  return d ? `https://${d}/` : null;
}

/** Plattformen und Verzeichnisse aussortieren; Index bleibt fuer den Judge stabil. */
export function kandidatenFiltern(treffer: Treffer[]): Treffer[] {
  return treffer.filter((t) => !istPlattform(t.domain)).slice(0, 6).map((t, i) => ({ ...t, index: i }));
}
