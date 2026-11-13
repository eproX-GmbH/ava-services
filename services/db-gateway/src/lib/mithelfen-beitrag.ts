// Burggraben-Punkt 4 (docs/PLAN_BURGGRABEN.md 5.3): sichtbarer Gegenwert fuers Mithelfen.
// Was die Desktop-Helfer eines Nutzers im laufenden und im vorigen Monat beigetragen
// haben (aus den erledigten RegisterJob-Zeilen, die sein Worker geleast hatte), dazu die
// gemeldete Einstellung je Geraet fuer die Opt-out-Quote des Betreibers.

import type pg from "pg";

export interface BeitragMonat {
  monat: string;
  jobs: number;
  abfragen: number;
  /** Gelesene Registerblaetter / Treffer. */
  treffer: number;
  /** Neue Firmen und geaenderte Firmen, die daraus fuer alle Nutzer entstanden sind. */
  neu: number;
  geaendert: number;
}

export interface MeinBeitrag {
  geraete: number;
  monat: BeitragMonat;
  vormonat: BeitragMonat;
  gesamt: { jobs: number; abfragen: number };
}

export const monatsKennung = (d: Date): string => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;

function leer(monat: string): BeitragMonat {
  return { monat, jobs: 0, abfragen: 0, treffer: 0, neu: 0, geaendert: 0 };
}

export async function meinBeitrag(pool: pg.Pool, actorId: string, jetzt = new Date()): Promise<MeinBeitrag> {
  const monat = monatsKennung(jetzt);
  const vormonat = monatsKennung(new Date(Date.UTC(jetzt.getUTCFullYear(), jetzt.getUTCMonth() - 1, 1)));
  const worker = await pool.query<{ workerId: string; jobsErledigt: number; abfragen: number }>(
    `SELECT "workerId", "jobsErledigt", abfragen FROM "RegisterWorker" WHERE "actorId" = $1 AND art = 'desktop'`,
    [actorId],
  );
  const out: MeinBeitrag = {
    geraete: worker.rows.length,
    monat: leer(monat),
    vormonat: leer(vormonat),
    gesamt: { jobs: worker.rows.reduce((s, w) => s + Number(w.jobsErledigt), 0), abfragen: worker.rows.reduce((s, w) => s + Number(w.abfragen), 0) },
  };
  if (worker.rows.length === 0) return out;
  const r = await pool.query<{ monat: string; jobs: string; abfragen: string; treffer: string; neu: string; geaendert: string }>(
    `SELECT to_char(date_trunc('month', "ergebnisAt" AT TIME ZONE 'UTC'), 'YYYY-MM') AS monat,
            count(*)::text AS jobs,
            COALESCE(sum(NULLIF(ergebnis->>'abfragen', '')::numeric), 0)::text AS abfragen,
            COALESCE(sum(NULLIF(ergebnis->>'treffer', '')::numeric), 0)::text AS treffer,
            COALESCE(sum(NULLIF(ergebnis->>'neu', '')::numeric), 0)::text AS neu,
            COALESCE(sum(NULLIF(ergebnis->>'geaendert', '')::numeric), 0)::text AS geaendert
       FROM "RegisterJob"
      WHERE "leasedBy" = ANY($1::text[]) AND status = 'erledigt'
        AND "ergebnisAt" >= (date_trunc('month', $2::timestamptz AT TIME ZONE 'UTC') - interval '1 month') AT TIME ZONE 'UTC'
      GROUP BY 1`,
    [worker.rows.map((w) => w.workerId), jetzt.toISOString()],
  );
  for (const row of r.rows) {
    const ziel = row.monat === monat ? out.monat : row.monat === vormonat ? out.vormonat : null;
    if (!ziel) continue;
    ziel.jobs = Number(row.jobs);
    ziel.abfragen = Math.round(Number(row.abfragen));
    ziel.treffer = Math.round(Number(row.treffer));
    ziel.neu = Math.round(Number(row.neu));
    ziel.geaendert = Math.round(Number(row.geaendert));
  }
  return out;
}

export type EinstellungQuelle = "standard" | "nutzer";

/** Desktop meldet seine Mithelfen-Einstellung; legt die Worker-Zeile an, falls der Worker nie lief. */
export async function mithelfenStandMelden(
  pool: pg.Pool,
  stand: { workerId: string; tenantId: string | null; actorId: string; aktiv: boolean; quelle: EinstellungQuelle },
): Promise<void> {
  await pool.query(
    `INSERT INTO "RegisterWorker" ("workerId", "tenantId", "actorId", "art", "einstellungAktiv", "einstellungQuelle", "einstellungAt")
     VALUES ($1, $2, $3, 'desktop', $4, $5, NOW())
     ON CONFLICT ("workerId") DO UPDATE
       SET "tenantId" = EXCLUDED."tenantId", "actorId" = EXCLUDED."actorId",
           "einstellungAktiv" = EXCLUDED."einstellungAktiv", "einstellungQuelle" = EXCLUDED."einstellungQuelle", "einstellungAt" = NOW()`,
    [stand.workerId, stand.tenantId, stand.actorId, stand.aktiv, stand.quelle],
  );
}

/** Betreiber: Verteilung der gemeldeten Einstellungen (Opt-out-Quote). */
export async function mithelfenStandUebersicht(pool: pg.Pool): Promise<{ gemeldet: number; an: number; aus: number; standardAn: number; nutzerAn: number; nutzerAus: number }> {
  const r = await pool.query<{ gemeldet: string; an: string; aus: string; standardAn: string; nutzerAn: string; nutzerAus: string }>(
    `SELECT count(*) FILTER (WHERE "einstellungAktiv" IS NOT NULL)::text AS gemeldet,
            count(*) FILTER (WHERE "einstellungAktiv" = true)::text AS an,
            count(*) FILTER (WHERE "einstellungAktiv" = false)::text AS aus,
            count(*) FILTER (WHERE "einstellungAktiv" = true AND "einstellungQuelle" = 'standard')::text AS "standardAn",
            count(*) FILTER (WHERE "einstellungAktiv" = true AND "einstellungQuelle" = 'nutzer')::text AS "nutzerAn",
            count(*) FILTER (WHERE "einstellungAktiv" = false AND "einstellungQuelle" = 'nutzer')::text AS "nutzerAus"
       FROM "RegisterWorker" WHERE art = 'desktop'`,
  );
  const z = r.rows[0];
  const n = (v: string | undefined) => Number(v ?? 0);
  return { gemeldet: n(z?.gemeldet), an: n(z?.an), aus: n(z?.aus), standardAn: n(z?.standardAn), nutzerAn: n(z?.nutzerAn), nutzerAus: n(z?.nutzerAus) };
}
