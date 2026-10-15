// Tatsaechliche Anbieterkosten (2026-10-15): statt Annahmen die Betraege, die OpenAI,
// Apify und Valueserp wirklich berechnen.
//
//   OpenAI    Admin-API der Organisation: Kosten je Tag (/v1/organization/costs) und
//             Verbrauch je Tag und Modell inkl. Cache-Tokens (/v1/organization/usage/
//             completions). Braucht OPENAI_ADMIN_KEY. Tabelle AnbieterKosten.
//   Apify     je Lauf die echten Kosten (GET /v2/actor-runs/{id} → usageTotalUsd) direkt
//             an der LlmUsage-Zeile (kind apify, ref = Lauf-Kennung); dazu das Monats-
//             konto (/v2/users/me/usage/monthly) als Gegenprobe.
//   Valueserp Fixpreis je Abfrage nach Tarif (Env VALUESERP_TARIF / _PREIS_MICROUSD),
//             je Abfrage an der ProxyAudit-Zeile; Kontostand (/account) als Gegenprobe.

import type { Pool } from "pg";
import { loadEnv } from "./env";
import { logger } from "./logger";

const APIFY_BASE = "https://api.apify.com";
const OPENAI_BASE = "https://api.openai.com";

export function valueserpTarif(): { name: string; preisMicroUsd: number } {
  const env = loadEnv();
  return { name: env.VALUESERP_TARIF ?? "Pay-as-you-go 2,50 USD je 1.000", preisMicroUsd: env.VALUESERP_PREIS_MICROUSD ?? 2500 };
}

function apifyToken(): string | null {
  return loadEnv().OPERATOR_APIFY_TOKEN ?? null;
}

async function upsert(pool: Pool, e: { quelle: string; tag: string; kennung: string; betragMicroUsd: number; menge?: number; details?: unknown }): Promise<void> {
  await pool.query(
    `INSERT INTO "AnbieterKosten" ("quelle", "tag", "kennung", "betragMicroUsd", "menge", "details", "abgerufenAt")
     VALUES ($1, $2::date, $3, $4, $5, $6::jsonb, NOW())
     ON CONFLICT ("quelle", "tag", "kennung") DO UPDATE SET "betragMicroUsd" = EXCLUDED."betragMicroUsd", "menge" = EXCLUDED."menge", "details" = EXCLUDED."details", "abgerufenAt" = NOW()`,
    [e.quelle, e.tag, e.kennung, Math.round(e.betragMicroUsd), Math.round(e.menge ?? 0), e.details == null ? null : JSON.stringify(e.details)],
  );
}

// ---- Apify: echte Kosten je Lauf --------------------------------------------

/** Lauf-Kennung aus der Apify-Antwort: Header (run-sync) oder Body (data.id bei /runs). */
export function apifyRunId(headers: Headers, bodyText: string | null): string | null {
  for (const h of ["x-apify-run-id", "x-apify-actor-run-id"]) {
    const v = headers.get(h);
    if (v) return v;
  }
  if (bodyText && bodyText.length < 200_000) {
    try {
      const j = JSON.parse(bodyText) as { data?: { id?: string; actId?: string } };
      if (j?.data?.id && j.data.actId) return j.data.id;
    } catch {
      /* Dataset-Items, kein Lauf-Objekt */
    }
  }
  return null;
}

/** Echte Kosten eines Laufs laut Apify (USD) oder null, wenn der Lauf noch laeuft/unbekannt. */
export async function apifyLaufKosten(runId: string): Promise<{ usd: number; status: string; actorId: string | null } | null> {
  const token = apifyToken();
  if (!token) return null;
  const res = await fetch(`${APIFY_BASE}/v2/actor-runs/${encodeURIComponent(runId)}?token=${encodeURIComponent(token)}`);
  if (!res.ok) return null;
  const j = (await res.json()) as { data?: { status?: string; usageTotalUsd?: number; actId?: string } };
  const d = j.data;
  if (!d || typeof d.usageTotalUsd !== "number") return null;
  return { usd: d.usageTotalUsd, status: d.status ?? "?", actorId: d.actId ?? null };
}

/** Letzter Lauf eines Actors (run-sync ohne Kennung im Header): Kennung + Kosten. */
async function apifyLetzterLauf(actorId: string): Promise<{ runId: string; usd: number | null; status: string } | null> {
  const token = apifyToken();
  if (!token) return null;
  const res = await fetch(`${APIFY_BASE}/v2/acts/${encodeURIComponent(actorId)}/runs/last?token=${encodeURIComponent(token)}`);
  if (!res.ok) return null;
  const j = (await res.json()) as { data?: { id?: string; status?: string; usageTotalUsd?: number } };
  if (!j.data?.id) return null;
  return { runId: j.data.id, usd: typeof j.data.usageTotalUsd === "number" ? j.data.usageTotalUsd : null, status: j.data.status ?? "?" };
}

/** Nach einem Apify-Aufruf: Lauf-Kennung und echte Kosten an die Verbrauchszeile schreiben. */
export async function apifyLaufNachtragen(pool: Pool, usageId: string, rest: string, headers: Headers, bodyText: string | null): Promise<void> {
  try {
    const m = /^acts\/([^/?]+)\/(run-sync[^/?]*|runs)/.exec(rest.replace(/^\/+/, ""));
    if (!m) return;
    const actorId = decodeURIComponent(m[1]!);
    let runId = apifyRunId(headers, bodyText);
    let usd: number | null = null;
    if (runId) {
      const k = await apifyLaufKosten(runId);
      usd = k?.usd ?? null;
    } else {
      const l = await apifyLetzterLauf(actorId);
      if (l) {
        runId = l.runId;
        usd = l.usd;
      }
    }
    if (!runId) return;
    await pool.query(`UPDATE "LlmUsage" SET "ref" = $2, "model" = $3, "costMicroUsd" = COALESCE($4, "costMicroUsd") WHERE "id" = $1`, [usageId, runId, actorId.slice(0, 120), usd == null ? null : Math.round(usd * 1e6)]);
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), usageId }, "[anbieter] Apify-Lauf nicht nachgetragen");
  }
}

/** Apify-Zeilen ohne Kosten (Lauf lief beim Aufruf noch) nachtragen, stuendlich. */
export async function apifyFehlendeKostenNachtragen(pool: Pool): Promise<number> {
  if (!apifyToken()) return 0;
  const r = await pool.query<{ id: string; ref: string }>(
    `SELECT "id", "ref" FROM "LlmUsage" WHERE kind = 'apify' AND "ref" IS NOT NULL AND "costMicroUsd" IS NULL AND "createdAt" > NOW() - INTERVAL '14 days' ORDER BY "createdAt" DESC LIMIT 200`,
  );
  let n = 0;
  for (const row of r.rows) {
    const k = await apifyLaufKosten(row.ref).catch(() => null);
    if (!k || !["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"].includes(k.status)) continue;
    await pool.query(`UPDATE "LlmUsage" SET "costMicroUsd" = $2 WHERE "id" = $1`, [row.id, Math.round(k.usd * 1e6)]);
    n++;
  }
  return n;
}

async function apifyMonatskonto(pool: Pool, monat: string): Promise<void> {
  const token = apifyToken();
  if (!token) return;
  const res = await fetch(`${APIFY_BASE}/v2/users/me/usage/monthly?date=${monat}&token=${encodeURIComponent(token)}`);
  if (!res.ok) throw new Error(`Apify usage/monthly ${res.status}`);
  const j = (await res.json()) as { data?: { totalUsageCreditsUsdAfterVolumeDiscount?: number; totalUsageCreditsUsdBeforeVolumeDiscount?: number; monthlyServiceUsage?: Record<string, { totalUsageCreditsUsdAfterVolumeDiscount?: number; quantity?: number }> } };
  const d = j.data;
  if (!d) return;
  const gesamt = d.totalUsageCreditsUsdAfterVolumeDiscount ?? d.totalUsageCreditsUsdBeforeVolumeDiscount ?? 0;
  await upsert(pool, { quelle: "apify", tag: `${monat}-01`, kennung: "monat", betragMicroUsd: gesamt * 1e6, details: d.monthlyServiceUsage ?? null });
  for (const [dienst, v] of Object.entries(d.monthlyServiceUsage ?? {})) {
    await upsert(pool, { quelle: "apify", tag: `${monat}-01`, kennung: `dienst:${dienst}`, betragMicroUsd: (v.totalUsageCreditsUsdAfterVolumeDiscount ?? 0) * 1e6, menge: v.quantity ?? 0 });
  }
}

// ---- OpenAI: Kosten und Verbrauch laut Admin-API ----------------------------

async function openaiAbgleich(pool: Pool, tage: number): Promise<void> {
  const key = loadEnv().OPENAI_ADMIN_KEY;
  if (!key) return;
  const start = Math.floor(Date.now() / 1000) - tage * 86_400;
  const hdr = { authorization: `Bearer ${key}` };
  // Kosten je Tag und Posten.
  let page: string | null = null;
  do {
    const url = new URL(`${OPENAI_BASE}/v1/organization/costs`);
    url.searchParams.set("start_time", String(start));
    url.searchParams.set("bucket_width", "1d");
    url.searchParams.set("limit", "31");
    url.searchParams.append("group_by", "line_item");
    if (page) url.searchParams.set("page", page);
    const res = await fetch(url, { headers: hdr });
    if (!res.ok) throw new Error(`OpenAI costs ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = (await res.json()) as { data: Array<{ start_time: number; results: Array<{ amount?: { value?: number }; line_item?: string | null; project_id?: string | null }> }>; has_more?: boolean; next_page?: string | null };
    for (const b of j.data) {
      const tag = new Date(b.start_time * 1000).toISOString().slice(0, 10);
      let summe = 0;
      for (const r of b.results) {
        const v = r.amount?.value ?? 0;
        summe += v;
        await upsert(pool, { quelle: "openai", tag, kennung: `posten:${r.line_item ?? "?"}`, betragMicroUsd: v * 1e6, details: { project_id: r.project_id ?? null } });
      }
      await upsert(pool, { quelle: "openai", tag, kennung: "gesamt", betragMicroUsd: summe * 1e6 });
    }
    page = j.has_more && j.next_page ? j.next_page : null;
  } while (page);
  // Verbrauch je Tag und Modell (mit Cache-Tokens), als Menge = Anfragen.
  page = null;
  do {
    const url = new URL(`${OPENAI_BASE}/v1/organization/usage/completions`);
    url.searchParams.set("start_time", String(start));
    url.searchParams.set("bucket_width", "1d");
    url.searchParams.set("limit", "31");
    url.searchParams.append("group_by", "model");
    if (page) url.searchParams.set("page", page);
    const res = await fetch(url, { headers: hdr });
    if (!res.ok) throw new Error(`OpenAI usage ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = (await res.json()) as { data: Array<{ start_time: number; results: Array<{ model?: string | null; input_tokens?: number; input_cached_tokens?: number; output_tokens?: number; num_model_requests?: number }> }>; has_more?: boolean; next_page?: string | null };
    for (const b of j.data) {
      const tag = new Date(b.start_time * 1000).toISOString().slice(0, 10);
      for (const r of b.results) {
        await upsert(pool, {
          quelle: "openai-verbrauch", tag, kennung: `modell:${r.model ?? "?"}`, betragMicroUsd: 0, menge: r.num_model_requests ?? 0,
          details: { input_tokens: r.input_tokens ?? 0, input_cached_tokens: r.input_cached_tokens ?? 0, output_tokens: r.output_tokens ?? 0 },
        });
      }
    }
    page = j.has_more && j.next_page ? j.next_page : null;
  } while (page);
}

// ---- Valueserp: Kontostand ---------------------------------------------------

async function valueserpAbgleich(pool: Pool): Promise<void> {
  const key = loadEnv().VALUESERP_API_KEY;
  if (!key) return;
  const res = await fetch(`https://api.valueserp.com/account?api_key=${encodeURIComponent(key)}`);
  if (!res.ok) throw new Error(`Valueserp account ${res.status}`);
  const j = (await res.json()) as { account_info?: Record<string, unknown> };
  const a = j.account_info ?? {};
  const tag = new Date().toISOString().slice(0, 10);
  const t = valueserpTarif();
  const verbraucht = Number(a["credits_used"] ?? a["credits_used_this_month"] ?? 0);
  await upsert(pool, { quelle: "valueserp", tag, kennung: "konto", betragMicroUsd: verbraucht * t.preisMicroUsd, menge: verbraucht, details: { ...a, tarif: t.name, preisMicroUsd: t.preisMicroUsd } });
}

/** Taeglicher Abgleich aller drei Anbieter; Fehler je Anbieter werden geloggt, nicht geworfen. */
export async function anbieterAbgleich(pool: Pool, now: Date = new Date()): Promise<void> {
  const monat = now.toISOString().slice(0, 7);
  const vormonat = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
  const schritte: Array<[string, () => Promise<unknown>]> = [
    ["openai", () => openaiAbgleich(pool, 35)],
    ["apify-monat", () => apifyMonatskonto(pool, monat)],
    ["apify-vormonat", () => apifyMonatskonto(pool, vormonat)],
    ["apify-laeufe", () => apifyFehlendeKostenNachtragen(pool)],
    ["valueserp", () => valueserpAbgleich(pool)],
  ];
  for (const [name, fn] of schritte) {
    try {
      await fn();
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err), name }, "[anbieter] Abgleich fehlgeschlagen");
    }
  }
}

// ---- Auswertung ----------------------------------------------------------------

export interface AnbieterMonat {
  monat: string;
  /** OpenAI: gerechnet aus LlmUsage (Betreiber-Spur) und laut Rechnung (Admin-API, ganze Organisation). */
  openaiGerechnetUsd: number;
  openaiLautAnbieterUsd: number | null;
  openaiCacheTokens: number;
  /** Apify: Summe der echten Laufkosten (LlmUsage) und Monatskonto laut Apify. */
  apifyLaeufe: number;
  apifyLaeufeOhneKosten: number;
  apifyLaeufeUsd: number;
  apifyKontoUsd: number | null;
  /** Valueserp: Abfragen je Tarif. */
  valueserp: Array<{ tarif: string; suchen: number; usd: number }>;
}

export async function anbieterJeMonat(pool: Pool, monate: number): Promise<{ monate: AnbieterMonat[]; stand: { openaiAdmin: boolean; apify: boolean; valueserp: boolean; zuletzt: string | null } }> {
  const [ll, ak, serp, zuletzt] = await Promise.all([
    pool.query<{ monat: string; kind: string; n: string; usd: string; ohne: string; cache: string }>(
      `SELECT to_char(date_trunc('month', "createdAt"), 'YYYY-MM') AS monat, kind, COUNT(*)::text AS n, COALESCE(SUM("costMicroUsd"), 0)::text AS usd,
              COUNT(*) FILTER (WHERE "costMicroUsd" IS NULL)::text AS ohne, COALESCE(SUM("cacheReadTokens"), 0)::text AS cache
         FROM "LlmUsage" WHERE kind IN ('betreiber', 'apify') AND "createdAt" > NOW() - ($1 || ' months')::interval GROUP BY 1, 2`,
      [String(monate)],
    ),
    pool.query<{ monat: string; quelle: string; kennung: string; usd: string }>(
      `SELECT to_char(date_trunc('month', "tag"), 'YYYY-MM') AS monat, quelle, kennung, SUM("betragMicroUsd")::text AS usd
         FROM "AnbieterKosten" WHERE "tag" > NOW() - ($1 || ' months')::interval AND ((quelle = 'openai' AND kennung = 'gesamt') OR (quelle = 'apify' AND kennung = 'monat')) GROUP BY 1, 2, 3`,
      [String(monate)],
    ),
    pool.query<{ monat: string; tarif: string | null; n: string; usd: string }>(
      `SELECT to_char(date_trunc('month', "createdAt"), 'YYYY-MM') AS monat, tarif, COUNT(*) FILTER (WHERE NOT "cacheHit" AND status < 400)::text AS n, COALESCE(SUM("kostenMicroUsd"), 0)::text AS usd
         FROM "ProxyAudit" WHERE proxy = 'valueserp' AND "createdAt" > NOW() - ($1 || ' months')::interval GROUP BY 1, 2`,
      [String(monate)],
    ),
    pool.query<{ zuletzt: Date | null }>(`SELECT MAX("abgerufenAt") AS zuletzt FROM "AnbieterKosten"`),
  ]);
  const je = new Map<string, AnbieterMonat>();
  const z = (m: string) => {
    let x = je.get(m);
    if (!x) {
      x = { monat: m, openaiGerechnetUsd: 0, openaiLautAnbieterUsd: null, openaiCacheTokens: 0, apifyLaeufe: 0, apifyLaeufeOhneKosten: 0, apifyLaeufeUsd: 0, apifyKontoUsd: null, valueserp: [] };
      je.set(m, x);
    }
    return x;
  };
  const t = valueserpTarif();
  for (const r of ll.rows) {
    const x = z(r.monat);
    if (r.kind === "betreiber") { x.openaiGerechnetUsd = Number(r.usd) / 1e6; x.openaiCacheTokens = Number(r.cache); }
    else { x.apifyLaeufe = Number(r.n); x.apifyLaeufeOhneKosten = Number(r.ohne); x.apifyLaeufeUsd = Number(r.usd) / 1e6; }
  }
  for (const r of ak.rows) {
    const x = z(r.monat);
    if (r.quelle === "openai") x.openaiLautAnbieterUsd = Number(r.usd) / 1e6;
    else x.apifyKontoUsd = Number(r.usd) / 1e6;
  }
  for (const r of serp.rows) {
    const x = z(r.monat);
    // Altzeilen vor dem Tarif-Stempel: heutiger Tarif als Annahme.
    const tarif = r.tarif ?? `${t.name} (angenommen)`;
    const usd = r.tarif ? Number(r.usd) / 1e6 : (Number(r.n) * t.preisMicroUsd) / 1e6;
    x.valueserp.push({ tarif, suchen: Number(r.n), usd: Math.round(usd * 100) / 100 });
  }
  const env = loadEnv();
  const rund = (v: number | null) => (v == null ? null : Math.round(v * 100) / 100);
  return {
    monate: [...je.values()].sort((a, b) => b.monat.localeCompare(a.monat)).map((x) => ({ ...x, openaiGerechnetUsd: rund(x.openaiGerechnetUsd)!, openaiLautAnbieterUsd: rund(x.openaiLautAnbieterUsd), apifyLaeufeUsd: rund(x.apifyLaeufeUsd)!, apifyKontoUsd: rund(x.apifyKontoUsd) })),
    stand: { openaiAdmin: Boolean(env.OPENAI_ADMIN_KEY), apify: Boolean(env.OPERATOR_APIFY_TOKEN), valueserp: Boolean(env.VALUESERP_API_KEY), zuletzt: zuletzt.rows[0]?.zuletzt ? new Date(zuletzt.rows[0].zuletzt).toISOString() : null },
  };
}

/** Faktor echte/gerechnete OpenAI-Kosten je Monat (fuer die Umlage auf Kunden); null ohne Abgleich. */
export async function openaiFaktorJeMonat(pool: Pool, monate: number): Promise<Map<string, number>> {
  const a = await anbieterJeMonat(pool, monate);
  const f = new Map<string, number>();
  for (const m of a.monate) if (m.openaiLautAnbieterUsd != null && m.openaiGerechnetUsd > 0) f.set(m.monat, m.openaiLautAnbieterUsd / m.openaiGerechnetUsd);
  return f;
}
