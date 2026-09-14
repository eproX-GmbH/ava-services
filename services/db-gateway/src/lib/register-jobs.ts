// Register-Delta S3 (docs/PLAN_STAMMDATEN_DELTA.md, 3.4) — Job-Queue mit Lease.
//
// Drei Job-Arten:
//   front            je (Gericht, Art): ab maxNummer+1 hochzaehlen, bis
//                    maxFehltreffer Fehltreffer in Folge; Luecken merken.
//   bekanntmachungen je Tag: Registerbekanntmachungen des Tages parsen.
//   refresh          Buendel bis 25 Firmen: exakte Abfrage, Vergleich.
//
// Der Worker (S4) fragt das Portal ab und meldet das Ergebnis; das Gateway
// schreibt ueber master-data (/internal/companies/register-delta, Upsert mit
// Aenderungserkennung) und pflegt die Nummernfront (/internal/register-front).
// Lease 20 Minuten, Rueckfall in die Queue bei Ablauf, maximal 5 Versuche.

import { createHmac } from "node:crypto";
import type pg from "pg";
import { loadEnv } from "./env";
import { logger } from "./logger";
import { getGatewayPool } from "./producer-pools";
import { companyIdAus } from "./register-ids";

export type JobArt = "front" | "bekanntmachungen" | "refresh";
export const JOB_ARTEN: JobArt[] = ["front", "bekanntmachungen", "refresh"];

export const LEASE_MINUTEN = 20;
export const MAX_VERSUCHE = 5;
/** Grenze der Nutzungsordnung des Registerportals je IP und Stunde. */
export const ABFRAGEN_JE_STUNDE = 60;
export const FRONT_MAX_FEHLTREFFER = 10;
export const BEKANNTMACHUNGEN_FENSTER_TAGE = 56;
export const REFRESH_BUENDEL = 25;
export const REFRESH_INTERVALL_TAGE = 90;

export type RegisterJob = {
  id: string;
  art: JobArt;
  schluessel: string;
  payload: Record<string, unknown>;
  status: "offen" | "laeuft" | "erledigt" | "fehlgeschlagen";
  prioritaet: number;
  leaseUntil: string | null;
  leasedBy: string | null;
  versuche: number;
};

/** Ergebniszeile des Workers = Eingabe fuer master-data upsertManyDelta. */
export type Treffer = {
  gericht: string;
  art: string;
  nummer: number;
  zusatz: string;
  frueher: string;
  bundesland: string;
  name: string;
  sitz: string;
  status: "ACTIVE" | "CLOSED" | "LOESCHUNG_ANGEKUENDIGT";
  historie: Array<{ name: string; sitz: string; order: number }>;
};

export type Bekanntmachung = {
  datum: string;
  kategorie: string;
  bundesland: string | null;
  gericht: string | null;
  art: string | null;
  nummer: number | null;
  zusatz: string;
  frueher: string;
  firma: string;
  sitz: string;
};

export type Ergebnis = {
  workerId: string;
  abfragen: number;
  gesperrt?: boolean;
  treffer: Treffer[];
  /** front: neuer Stand nach dem Lauf. */
  front?: { maxNummer: number; offeneLuecken: number[]; zusaetze?: string[] };
  /** bekanntmachungen: alle Eintraege des Tages. */
  bekanntmachungen?: Bekanntmachung[];
};

type Q = { query: pg.Pool["query"] };

function rowToJob(r: Record<string, unknown>): RegisterJob {
  return {
    id: String(r.id),
    art: r.art as JobArt,
    schluessel: String(r.schluessel),
    payload: (r.payload as Record<string, unknown>) ?? {},
    status: r.status as RegisterJob["status"],
    prioritaet: Number(r.prioritaet),
    leaseUntil: r.leaseUntil ? new Date(r.leaseUntil as string).toISOString() : null,
    leasedBy: (r.leasedBy as string | null) ?? null,
    versuche: Number(r.versuche ?? 0),
  };
}

// ---- master-data (HMAC) ----------------------------------------------------

async function masterData<T>(method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<T> {
  const env = loadEnv();
  if (!env.INTERNAL_HMAC_SECRET) throw new Error("INTERNAL_HMAC_SECRET unset");
  const raw = JSON.stringify(body ?? {});
  const sig = createHmac("sha256", env.INTERNAL_HMAC_SECRET).update(raw, "utf8").digest("hex");
  const res = await fetch(`${env.UPSTREAM_MASTER_DATA_URL.replace(/\/$/, "")}${path}`, {
    method,
    headers: { "content-type": "application/json", "x-internal-signature": sig },
    body: raw,
  });
  if (!res.ok) throw new Error(`master-data ${method} ${path} → ${res.status}`);
  return (await res.json()) as T;
}

export type Front = {
  districtCourt: string;
  registerType: string;
  maxNummer: number;
  zusaetze: string[];
  offeneLuecken: number[];
  zuletztGeprueftAt: string | null;
};

export async function ladeFronten(): Promise<Front[]> {
  const r = await masterData<{ fronts: Front[] }>("GET", "/internal/register-front");
  return r.fronts;
}

function nameNormalisiert(name: string): string {
  return name.toLowerCase().replace(/\s+/g, " ").trim();
}

function trefferZuDelta(t: Treffer) {
  const companyId = companyIdAus(t.gericht, t.art, t.nummer, t.zusatz, t.frueher);
  return {
    companyId,
    name: t.name,
    nameNormalized: nameNormalisiert(t.name),
    registerType: t.art,
    registerNumber: `${t.nummer}${t.zusatz ? ` ${t.zusatz}` : ""}`,
    location: t.sitz,
    districtCourt: t.gericht,
    state: t.bundesland,
    registerStatus: t.status,
    formerCourt: t.frueher || null,
    history: t.historie.map((h) => ({ name: h.name, nameNormalized: nameNormalisiert(h.name), location: h.sitz, order: h.order })),
  };
}

type DeltaAntwort = { neu: number; geaendert: number; unveraendert: number; befunde: Array<{ companyId: string; befund: string; felder?: string[] }> };

async function schreibeTreffer(treffer: Treffer[], source: string): Promise<{ neu: number; geaendert: number; unveraendert: number }> {
  const summe = { neu: 0, geaendert: 0, unveraendert: 0 };
  const gesehenAt = new Date().toISOString();
  for (let i = 0; i < treffer.length; i += 1000) {
    const r = await masterData<DeltaAntwort>("POST", "/internal/companies/register-delta", {
      companies: treffer.slice(i, i + 1000).map(trefferZuDelta),
      source,
      gesehenAt,
    });
    summe.neu += r.neu;
    summe.geaendert += r.geaendert;
    summe.unveraendert += r.unveraendert;
  }
  return summe;
}

// ---- Erzeugung ------------------------------------------------------------

async function legeJobAn(q: Q, art: JobArt, schluessel: string, payload: Record<string, unknown>, prioritaet: number): Promise<boolean> {
  const r = await q.query(
    `INSERT INTO "RegisterJob" ("art", "schluessel", "payload", "prioritaet")
     VALUES ($1, $2, $3::jsonb, $4) ON CONFLICT ("schluessel") DO NOTHING`,
    [art, schluessel, JSON.stringify(payload), prioritaet],
  );
  return (r.rowCount ?? 0) > 0;
}

function tagIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Ersteller (taeglich): Front-Jobs je (Gericht, Art), deren letzte Pruefung
 * aelter als ein Tag ist; Bekanntmachungs-Jobs fuer jeden Tag im Fenster
 * (idempotent, nachholbar nach Pausen bis 8 Wochen). Refresh-Jobs entstehen
 * aus Bekanntmachungen (siehe verarbeiteErgebnis) und aus expliziten
 * Anforderungen (refreshAnfordern).
 */
export async function erzeugeJobs(pool: pg.Pool, now: Date = new Date()): Promise<{ front: number; bekanntmachungen: number }> {
  let front = 0;
  let bek = 0;
  const heute = tagIso(now);
  try {
    const fronten = await ladeFronten();
    for (const f of fronten) {
      const geprueft = f.zuletztGeprueftAt ? new Date(f.zuletztGeprueftAt).getTime() : 0;
      if (now.getTime() - geprueft < 20 * 3600_000) continue;
      const ok = await legeJobAn(
        pool,
        "front",
        `front:${f.districtCourt}:${f.registerType}:${f.maxNummer}:${heute}`,
        {
          gericht: f.districtCourt,
          art: f.registerType,
          abNummer: f.maxNummer + 1,
          maxFehltreffer: FRONT_MAX_FEHLTREFFER,
          offeneLuecken: f.offeneLuecken,
          zusaetze: f.zusaetze,
        },
        // Grosse Gerichte zuerst: dort entstehen die meisten Firmen.
        f.maxNummer > 50_000 ? 3 : 4,
      );
      if (ok) front++;
    }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "[register-jobs] Fronten nicht ladbar");
  }
  // Bekanntmachungen: gestern bis Fensteranfang; heute erst morgen (Tag unvollstaendig).
  for (let i = 1; i <= BEKANNTMACHUNGEN_FENSTER_TAGE; i++) {
    const tag = tagIso(new Date(now.getTime() - i * 86_400_000));
    const ok = await legeJobAn(pool, "bekanntmachungen", `bek:${tag}`, { tag }, 1);
    if (ok) bek++;
  }
  return { front, bekanntmachungen: bek };
}

/** Refresh-Jobs fuer konkrete Blaetter (Buendel zu 25), z. B. aus Bekanntmachungen oder Nutzerbestand. */
export async function refreshAnfordern(
  q: Q,
  firmen: Array<{ gericht: string; art: string; nummer: number; zusatz?: string; hinweis?: string }>,
  grund: string,
  prioritaet = 2,
): Promise<number> {
  let n = 0;
  const gesehen = new Set<string>();
  const eindeutig = firmen.filter((f) => {
    const k = `${f.gericht}|${f.art}|${f.nummer}`;
    if (gesehen.has(k)) return false;
    gesehen.add(k);
    return true;
  });
  for (let i = 0; i < eindeutig.length; i += REFRESH_BUENDEL) {
    const buendel = eindeutig.slice(i, i + REFRESH_BUENDEL);
    const schluessel = `refresh:${grund}:${buendel.map((f) => companyIdAus(f.gericht, f.art, f.nummer)).join(",")}`.slice(0, 900);
    if (await legeJobAn(q, "refresh", schluessel, { firmen: buendel, grund }, prioritaet)) n++;
  }
  return n;
}

// ---- Lease / Ergebnis -------------------------------------------------------

export async function leaseJob(pool: pg.Pool, workerId: string, arten: JobArt[] = JOB_ARTEN): Promise<RegisterJob | null> {
  const r = await pool.query(
    `UPDATE "RegisterJob" SET "status" = 'laeuft', "leasedBy" = $1,
            "leaseUntil" = NOW() + ($2 || ' minutes')::interval, "versuche" = "versuche" + 1, "updatedAt" = NOW()
      WHERE "id" = (
        SELECT "id" FROM "RegisterJob"
         WHERE "art" = ANY($3::text[])
           AND ("status" = 'offen' OR ("status" = 'laeuft' AND "leaseUntil" < NOW()))
           AND "versuche" < $4
         ORDER BY "prioritaet", "id"
         FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING *`,
    [workerId, String(LEASE_MINUTEN), arten, MAX_VERSUCHE],
  );
  // Abgelaufene Leases mit ausgeschoepften Versuchen endgueltig markieren.
  await pool.query(
    `UPDATE "RegisterJob" SET "status" = 'fehlgeschlagen', "fehler" = COALESCE("fehler", 'Lease abgelaufen'), "updatedAt" = NOW()
      WHERE "status" = 'laeuft' AND "leaseUntil" < NOW() AND "versuche" >= $1`,
    [MAX_VERSUCHE],
  );
  if (r.rowCount === 0) return null;
  return rowToJob(r.rows[0] as Record<string, unknown>);
}

async function ladeGeleastenJob(q: Q, jobId: string, workerId: string): Promise<RegisterJob> {
  const r = await q.query(`SELECT * FROM "RegisterJob" WHERE "id" = $1`, [jobId]);
  if (r.rowCount === 0) throw new JobFehler(404, "job_unbekannt");
  const job = rowToJob(r.rows[0] as Record<string, unknown>);
  if (job.status !== "laeuft" || job.leasedBy !== workerId) throw new JobFehler(409, "lease_nicht_gueltig");
  return job;
}

export class JobFehler extends Error {
  constructor(public readonly status: 404 | 409 | 400, message: string) {
    super(message);
  }
}

export async function verarbeiteErgebnis(pool: pg.Pool, jobId: string, ergebnis: Ergebnis): Promise<Record<string, unknown>> {
  const job = await ladeGeleastenJob(pool, jobId, ergebnis.workerId);
  const zusammenfassung: Record<string, unknown> = { abfragen: ergebnis.abfragen, treffer: ergebnis.treffer.length };

  if (ergebnis.gesperrt) {
    // Portal hat gesperrt: Job zurueck in die Queue, Worker fuer eine Stunde merken.
    await pool.query(
      `UPDATE "RegisterJob" SET "status" = 'offen', "leasedBy" = NULL, "leaseUntil" = NULL, "fehler" = 'Portal gesperrt', "updatedAt" = NOW() WHERE "id" = $1`,
      [jobId],
    );
    await pool.query(`UPDATE "RegisterWorker" SET "gesperrtAt" = NOW(), "zuletztAt" = NOW(), "abfragen" = "abfragen" + $2 WHERE "workerId" = $1`, [
      ergebnis.workerId,
      ergebnis.abfragen,
    ]);
    return { ...zusammenfassung, status: "zurueckgestellt" };
  }

  if (ergebnis.treffer.length > 0) {
    Object.assign(zusammenfassung, await schreibeTreffer(ergebnis.treffer, job.art === "bekanntmachungen" ? "bekanntmachung" : "registerportal"));
  }

  if (job.art === "front" && ergebnis.front) {
    const p = job.payload as { gericht: string; art: string; zusaetze?: string[] };
    await masterData("PUT", "/internal/register-front", {
      fronts: [
        {
          districtCourt: p.gericht,
          registerType: p.art,
          maxNummer: ergebnis.front.maxNummer,
          zusaetze: ergebnis.front.zusaetze ?? p.zusaetze ?? [],
          offeneLuecken: ergebnis.front.offeneLuecken,
          zuletztGeprueftAt: new Date().toISOString(),
        },
      ],
    });
    zusammenfassung.maxNummer = ergebnis.front.maxNummer;
    // Front ist weitergewandert: sofort den naechsten Abschnitt einreihen (Aufholen).
    if (ergebnis.treffer.length > 0) {
      await legeJobAn(
        pool,
        "front",
        `front:${p.gericht}:${p.art}:${ergebnis.front.maxNummer}:${tagIso(new Date())}`,
        { gericht: p.gericht, art: p.art, abNummer: ergebnis.front.maxNummer + 1, maxFehltreffer: FRONT_MAX_FEHLTREFFER, offeneLuecken: ergebnis.front.offeneLuecken, zusaetze: ergebnis.front.zusaetze ?? p.zusaetze ?? [] },
        job.prioritaet,
      );
    }
  }

  if (job.art === "bekanntmachungen" && ergebnis.bekanntmachungen) {
    const p = job.payload as { tag: string };
    const mitBlatt = ergebnis.bekanntmachungen.filter((b) => b.gericht && b.art && b.nummer != null);
    const n = await refreshAnfordern(
      pool,
      mitBlatt.map((b) => ({
        gericht: b.gericht as string,
        art: b.art as string,
        nummer: b.nummer as number,
        zusatz: b.zusatz,
        hinweis: /Löschung|Loeschung/.test(b.kategorie) ? "loeschung_angekuendigt" : b.kategorie,
      })),
      `bek-${p.tag}`,
    );
    zusammenfassung.bekanntmachungen = ergebnis.bekanntmachungen.length;
    zusammenfassung.refreshJobs = n;
  }

  await pool.query(
    `UPDATE "RegisterJob" SET "status" = 'erledigt', "ergebnis" = $2::jsonb, "ergebnisAt" = NOW(), "leaseUntil" = NULL, "fehler" = NULL, "updatedAt" = NOW() WHERE "id" = $1`,
    [jobId, JSON.stringify(zusammenfassung)],
  );
  await pool.query(
    `UPDATE "RegisterWorker" SET "zuletztAt" = NOW(), "jobsErledigt" = "jobsErledigt" + 1, "abfragen" = "abfragen" + $2 WHERE "workerId" = $1`,
    [ergebnis.workerId, ergebnis.abfragen],
  );
  return { ...zusammenfassung, status: "erledigt" };
}

export async function meldeFehler(pool: pg.Pool, jobId: string, workerId: string, grund: string, abfragen = 0): Promise<{ status: string }> {
  const job = await ladeGeleastenJob(pool, jobId, workerId);
  const endgueltig = job.versuche >= MAX_VERSUCHE;
  await pool.query(
    `UPDATE "RegisterJob" SET "status" = $2, "leasedBy" = NULL, "leaseUntil" = NULL, "fehler" = $3, "updatedAt" = NOW() WHERE "id" = $1`,
    [jobId, endgueltig ? "fehlgeschlagen" : "offen", grund.slice(0, 500)],
  );
  await pool.query(`UPDATE "RegisterWorker" SET "zuletztAt" = NOW(), "abfragen" = "abfragen" + $2 WHERE "workerId" = $1`, [workerId, abfragen]);
  return { status: endgueltig ? "fehlgeschlagen" : "offen" };
}

export async function registriereWorker(q: Q, workerId: string, tenantId: string | null, actorId: string | null, art: "desktop" | "betreiber"): Promise<void> {
  await q.query(
    `INSERT INTO "RegisterWorker" ("workerId", "tenantId", "actorId", "art") VALUES ($1, $2, $3, $4)
     ON CONFLICT ("workerId") DO UPDATE SET "zuletztAt" = NOW(), "tenantId" = EXCLUDED."tenantId", "actorId" = EXCLUDED."actorId"`,
    [workerId, tenantId, actorId, art],
  );
}

export type Statistik = {
  jobs: Record<JobArt, Record<string, number>>;
  workerAktiv: number;
  abfragenHeute: number;
  erledigtHeute: number;
  aeltesterOffenerAt: string | null;
};

export async function statistik(pool: pg.Pool): Promise<Statistik> {
  const jobs: Record<JobArt, Record<string, number>> = { front: {}, bekanntmachungen: {}, refresh: {} };
  const r = await pool.query<{ art: JobArt; status: string; n: string }>(`SELECT "art", "status", count(*)::text AS n FROM "RegisterJob" GROUP BY 1, 2`);
  for (const row of r.rows) if (jobs[row.art]) jobs[row.art][row.status] = Number(row.n);
  const w = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM "RegisterWorker" WHERE "zuletztAt" > NOW() - interval '1 hour'`);
  const h = await pool.query<{ abfragen: string; erledigt: string; aeltester: Date | null }>(
    `SELECT COALESCE(sum((("ergebnis"->>'abfragen')::int)), 0)::text AS abfragen,
            count(*) FILTER (WHERE "ergebnisAt" > date_trunc('day', NOW()))::text AS erledigt,
            (SELECT min("createdAt") FROM "RegisterJob" WHERE "status" = 'offen') AS aeltester
       FROM "RegisterJob" WHERE "ergebnisAt" > date_trunc('day', NOW())`,
  );
  return {
    jobs,
    workerAktiv: Number(w.rows[0]?.n ?? 0),
    abfragenHeute: Number(h.rows[0]?.abfragen ?? 0),
    erledigtHeute: Number(h.rows[0]?.erledigt ?? 0),
    aeltesterOffenerAt: h.rows[0]?.aeltester ? new Date(h.rows[0].aeltester).toISOString() : null,
  };
}

// ---- Cron -------------------------------------------------------------------

let letzterErstellTag: string | null = null;

export async function runRegisterJobCronOnce(now: Date = new Date()): Promise<void> {
  const tag = tagIso(now);
  if (now.getUTCHours() >= 2 && letzterErstellTag !== tag) {
    letzterErstellTag = tag;
    const r = await erzeugeJobs(getGatewayPool(), now);
    logger.info(r, "[register-jobs] Jobs erzeugt");
  }
}

/** Stuendlicher Tick; Erzeugung einmal taeglich ab 02:00 UTC. REGISTER_JOBS_DISABLED=1 schaltet ab. */
export function startRegisterJobCron(): void {
  if (process.env.REGISTER_JOBS_DISABLED === "1") {
    logger.info("[register-jobs] cron deaktiviert");
    return;
  }
  const INTERVAL_MS = 60 * 60_000;
  setTimeout(() => {
    void runRegisterJobCronOnce().catch((err) => logger.warn({ err: err instanceof Error ? err.message : String(err) }, "[register-jobs] cron failed"));
    setInterval(() => {
      void runRegisterJobCronOnce().catch((err) => logger.warn({ err: err instanceof Error ? err.message : String(err) }, "[register-jobs] cron failed"));
    }, INTERVAL_MS);
  }, 90_000);
  logger.info({ intervalMs: INTERVAL_MS }, "[register-jobs] cron scheduled");
}
