// Betreiber-Sicht auf die Stammdatenpflege (Register-Delta): Warteschlange, Durchsatz,
// Server-Worker (mit Fly-Maschinenzustand), Desktop-Helfer, Aenderungsprotokoll aus
// master-data und Warnungen bei Stillstand. Nur ueber Betreiber-Routen erreichbar.

import type { Pool } from "pg";
import { masterData } from "./register-jobs";
import { logger } from "./logger";

const FLY_TOKEN = () => process.env.FLY_API_TOKEN?.trim() || "";
const WORKER_APP = () => process.env.REGISTER_WORKER_APP?.trim() || "ava-register-worker";
/** Ab wann ein Server-Worker als stehend gilt. */
const STILL_MIN = Number(process.env.REGISTER_WORKER_STILL_MIN ?? "120");

export interface ServerWorker {
  workerId: string;
  maschine: string | null;
  gruppe: string | null;
  zustand: string | null;
  region: string | null;
  standby: boolean;
  maschineAktualisiert: string | null;
  zuletztAt: string | null;
  jobsErledigt: number;
  abfragen: number;
  gesperrtAt: string | null;
  aktuellerJob: { id: number; art: string; schluessel: string; seit: string | null } | null;
  aktiv: boolean;
}

async function flyMaschinen(): Promise<Array<{ id: string; state: string; region: string; updated_at: string; config?: { metadata?: Record<string, string>; standbys?: string[] } }> | null> {
  if (!FLY_TOKEN()) return null;
  try {
    const res = await fetch(`https://api.machines.dev/v1/apps/${WORKER_APP()}/machines`, { headers: { authorization: `Bearer ${FLY_TOKEN()}` }, signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return null;
    return (await res.json()) as Array<{ id: string; state: string; region: string; updated_at: string; config?: { metadata?: Record<string, string>; standbys?: string[] } }>;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "[stammdaten] Fly-Maschinen nicht lesbar");
    return null;
  }
}

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

export async function pflegeUebersicht(pool: Pool, tage: number) {
  const [queue, durchsatz, veraltet, worker, jobsLaufend, fehlgeschlagen, statistik, maschinen] = await Promise.all([
    pool.query<{ art: string; status: string; n: string }>(`SELECT art, status, COUNT(*)::text AS n FROM "RegisterJob" GROUP BY 1, 2`),
    pool.query<{ tag: Date; art: string; n: string }>(`SELECT date_trunc('day', "ergebnisAt") AS tag, art, COUNT(*)::text AS n FROM "RegisterJob" WHERE "ergebnisAt" > NOW() - ($1 || ' days')::interval GROUP BY 1, 2 ORDER BY 1`, [String(tage)]),
    pool.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM "StructuredContentStale"`),
    pool.query<{ workerId: string; tenantId: string | null; actorId: string | null; art: string; zuletztAt: Date | null; jobsErledigt: number; abfragen: number; gesperrtAt: Date | null }>(`SELECT "workerId", "tenantId", "actorId", art, "zuletztAt", "jobsErledigt", abfragen, "gesperrtAt" FROM "RegisterWorker" WHERE art = 'betreiber' ORDER BY "zuletztAt" DESC NULLS LAST`),
    pool.query<{ id: string; art: string; schluessel: string; leasedBy: string; leaseUntil: Date | null }>(`SELECT id::text, art, schluessel, "leasedBy", "leaseUntil" FROM "RegisterJob" WHERE status = 'laeuft'`),
    pool.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM "RegisterJob" WHERE status = 'fehlgeschlagen'`),
    masterData<{ jeTag: Array<{ tag: string; art: string; country: string; n: number }>; fronten: { anzahl: number; geprueft24h: number; aelteste: string | null } }>("POST", "/internal/register-ereignisse/statistik", { tage }).catch((err: unknown) => {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "[stammdaten] Statistik aus master-data nicht lesbar");
      return null;
    }),
    flyMaschinen(),
  ]);

  const warteschlange: Record<string, Record<string, number>> = {};
  for (const r of queue.rows) (warteschlange[r.art] ??= {})[r.status] = Number(r.n);

  const jetzt = Date.now();
  const jobVon = (workerId: string) => {
    const j = jobsLaufend.rows.find((x) => x.leasedBy === workerId);
    return j ? { id: Number(j.id), art: j.art, schluessel: j.schluessel, seit: j.leaseUntil ? new Date(new Date(j.leaseUntil).getTime() - 20 * 60_000).toISOString() : null } : null;
  };
  // Server: Fly-Maschinen mit Worker-Zeilen zusammenfuehren (workerId "betreiber-<maschine>"
  // bzw. "betreiber-<gruppe>"); Zeilen ohne Maschine (lokale Tests) bleiben aussen vor,
  // wenn sie laenger als 7 Tage still sind.
  const server: ServerWorker[] = [];
  const genutzt = new Set<string>();
  for (const m of maschinen ?? []) {
    const gruppe = m.config?.metadata?.fly_process_group ?? null;
    const w = worker.rows.find((x) => x.workerId === `betreiber-${m.id}`) ?? worker.rows.find((x) => gruppe && x.workerId === `betreiber-${gruppe.replace(/^worker_/, "")}`);
    if (w) genutzt.add(w.workerId);
    const zuletzt = w?.zuletztAt ? new Date(w.zuletztAt).getTime() : 0;
    server.push({
      workerId: w?.workerId ?? `betreiber-${m.id}`, maschine: m.id, gruppe, zustand: m.state, region: m.region, standby: Boolean(m.config?.standbys?.length),
      maschineAktualisiert: iso(m.updated_at), zuletztAt: iso(w?.zuletztAt), jobsErledigt: w?.jobsErledigt ?? 0, abfragen: w?.abfragen ?? 0, gesperrtAt: iso(w?.gesperrtAt),
      aktuellerJob: w ? jobVon(w.workerId) : null, aktiv: m.state === "started" && zuletzt > jetzt - STILL_MIN * 60_000,
    });
  }
  for (const w of worker.rows) {
    if (genutzt.has(w.workerId)) continue;
    const zuletzt = w.zuletztAt ? new Date(w.zuletztAt).getTime() : 0;
    if (zuletzt < jetzt - 7 * 86_400_000) continue;
    server.push({ workerId: w.workerId, maschine: null, gruppe: null, zustand: null, region: null, standby: false, maschineAktualisiert: null, zuletztAt: iso(w.zuletztAt), jobsErledigt: w.jobsErledigt, abfragen: w.abfragen, gesperrtAt: iso(w.gesperrtAt), aktuellerJob: jobVon(w.workerId), aktiv: zuletzt > jetzt - STILL_MIN * 60_000 });
  }

  const helfer = await pool.query<{ aktiv: string; gesamt: string }>(`SELECT COUNT(*) FILTER (WHERE "zuletztAt" > NOW() - INTERVAL '15 minutes')::text AS aktiv, COUNT(*)::text AS gesamt FROM "RegisterWorker" WHERE art = 'desktop'`);

  const warnungen: Array<{ stufe: "fehler" | "warnung"; text: string }> = [];
  for (const s of server) {
    if (s.standby) continue;
    const name = s.gruppe ?? s.workerId;
    if (s.zustand && s.zustand !== "started") warnungen.push({ stufe: "fehler", text: `Server-Worker ${name} ist ${s.zustand === "stopped" ? "gestoppt" : s.zustand} (seit ${s.maschineAktualisiert ? new Date(s.maschineAktualisiert).toLocaleString("de-DE", { timeZone: "Europe/Berlin" }) : "?"}).` });
    else if (!s.aktiv) warnungen.push({ stufe: "warnung", text: `Server-Worker ${name} hat sich seit über ${Math.round(STILL_MIN / 60)} Stunden nicht gemeldet.` });
    if (s.gesperrtAt && new Date(s.gesperrtAt).getTime() > jetzt - 3_600_000) warnungen.push({ stufe: "warnung", text: `Server-Worker ${name} wurde vom Registerportal vorübergehend gesperrt.` });
  }
  if (maschinen === null) warnungen.push({ stufe: "warnung", text: "Zustand der Fly-Maschinen nicht lesbar (FLY_API_TOKEN am Gateway prüfen)." });
  const fehlg = Number(fehlgeschlagen.rows[0]?.n ?? 0);
  if (fehlg > 0) warnungen.push({ stufe: "warnung", text: `${fehlg} Jobs sind endgültig fehlgeschlagen (werden nach 12 Stunden automatisch erneut versucht).` });
  const heute = durchsatz.rows.filter((r) => new Date(r.tag).toISOString().slice(0, 10) === new Date().toISOString().slice(0, 10)).reduce((a, r) => a + Number(r.n), 0);

  return {
    tage,
    warteschlange,
    durchsatz: durchsatz.rows.map((r) => ({ tag: new Date(r.tag).toISOString().slice(0, 10), art: r.art, n: Number(r.n) })),
    heuteErledigt: heute,
    veraltet: Number(veraltet.rows[0]?.n ?? 0),
    fehlgeschlagen: fehlg,
    server,
    helfer: { aktiv: Number(helfer.rows[0]?.aktiv ?? 0), gesamt: Number(helfer.rows[0]?.gesamt ?? 0) },
    ereignisse: statistik?.jeTag ?? null,
    fronten: statistik?.fronten ?? null,
    warnungen,
  };
}

/** Desktop-Helfer ("Stammdaten mitpflegen"), blaetterbar; aktiv = Meldung in den letzten 15 Minuten. */
export async function helferListe(pool: Pool, q: { seite: number; groesse: number; nurAktiv: boolean }) {
  const where = `WHERE w.art = 'desktop'${q.nurAktiv ? ` AND w."zuletztAt" > NOW() - INTERVAL '15 minutes'` : ""}`;
  const [n, rows, jobs] = await Promise.all([
    pool.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM "RegisterWorker" w ${where}`),
    pool.query<{ workerId: string; tenantId: string | null; actorId: string | null; zuletztAt: Date | null; jobsErledigt: number; abfragen: number; gesperrtAt: Date | null; email: string | null; name: string | null; organisation: string | null }>(
      `SELECT w."workerId", w."tenantId", w."actorId", w."zuletztAt", w."jobsErledigt", w.abfragen, w."gesperrtAt", m.email, m.name, t.name AS organisation
         FROM "RegisterWorker" w LEFT JOIN "TenantMember" m ON m."actorId" = w."actorId" LEFT JOIN "Tenant" t ON t.id = w."tenantId"
         ${where} ORDER BY w."zuletztAt" DESC NULLS LAST LIMIT $1 OFFSET $2`,
      [q.groesse, (q.seite - 1) * q.groesse],
    ),
    pool.query<{ leasedBy: string; art: string; schluessel: string }>(`SELECT "leasedBy", art, schluessel FROM "RegisterJob" WHERE status = 'laeuft'`),
  ]);
  const jetzt = Date.now();
  return {
    gesamt: Number(n.rows[0]?.n ?? 0),
    seite: q.seite,
    groesse: q.groesse,
    items: rows.rows.map((r) => {
      const geraet = r.workerId.replace(/^desktop-[^-]+-/, "");
      const j = jobs.rows.find((x) => x.leasedBy === r.workerId);
      return {
        workerId: r.workerId, geraet, email: r.email, name: r.name, organisation: r.organisation, zuletztAt: iso(r.zuletztAt), jobsErledigt: r.jobsErledigt, abfragen: r.abfragen, gesperrtAt: iso(r.gesperrtAt),
        aktiv: !!r.zuletztAt && new Date(r.zuletztAt).getTime() > jetzt - 15 * 60_000, aktuellerJob: j ? { art: j.art, schluessel: j.schluessel } : null,
      };
    }),
  };
}

export async function fehlgeschlageneJobs(pool: Pool, q: { seite: number; groesse: number }) {
  const [n, rows] = await Promise.all([
    pool.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM "RegisterJob" WHERE status = 'fehlgeschlagen'`),
    pool.query<{ id: string; art: string; schluessel: string; versuche: number; fehler: string | null; ergebnisAt: Date | null; leasedBy: string | null }>(`SELECT id::text, art, schluessel, versuche, fehler, "ergebnisAt", "leasedBy" FROM "RegisterJob" WHERE status = 'fehlgeschlagen' ORDER BY id DESC LIMIT $1 OFFSET $2`, [q.groesse, (q.seite - 1) * q.groesse]),
  ]);
  return { gesamt: Number(n.rows[0]?.n ?? 0), items: rows.rows.map((r) => ({ id: Number(r.id), art: r.art, schluessel: r.schluessel, versuche: r.versuche, fehler: r.fehler, zuletzt: iso(r.ergebnisAt), worker: r.leasedBy })) };
}

export async function jobWiederholen(pool: Pool, id: number): Promise<boolean> {
  const r = await pool.query(`UPDATE "RegisterJob" SET status = 'offen', versuche = 0, fehler = NULL, "leaseUntil" = NULL, "leasedBy" = NULL WHERE id = $1 AND status = 'fehlgeschlagen'`, [id]);
  return (r.rowCount ?? 0) > 0;
}
