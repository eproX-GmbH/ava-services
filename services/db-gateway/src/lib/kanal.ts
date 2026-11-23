// Staging/UAT (docs/PLAN_STAGING.md): Kanal je Konto, Rolle dieses Gateways, Test-Adressen,
// Release-Kandidaten. Beide Gateways (Prod und Staging) teilen die Datenbank; dieser Stand wird
// alle 30 s und nach jeder Änderung neu geladen, damit die Weiche ohne Datenbankabfrage je
// Anfrage entscheidet.
import type pg from "pg";
import { logger } from "./logger";

export type Kanal = "prod" | "staging";
export type Rolle = "prod" | "staging";
export type ReleaseStatus = "kandidat" | "freigegeben" | "verworfen";

/** Welcher Code-Stand läuft hier: Prod-Gateway (Standard) oder Staging-Gateway. */
export const gatewayRolle = (): Rolle => (process.env.GATEWAY_ROLLE === "staging" ? "staging" : "prod");

interface Zugang { kanal: Kanal; testZahlung: boolean }
interface Stand { zugang: Map<string, Zugang>; muster: string[]; routing: boolean; geladenAt: number }
let stand: Stand = { zugang: new Map(), muster: [], routing: false, geladenAt: 0 };

/** Nur für Tests: Stand direkt setzen. */
export function kanalStandSetzen(s: { zugang?: Array<[string, Zugang]>; muster?: string[]; routing?: boolean }): void {
  stand = { zugang: new Map(s.zugang ?? []), muster: s.muster ?? [], routing: s.routing ?? false, geladenAt: Date.now() };
}

export async function kanalLaden(pool: pg.Pool): Promise<void> {
  const [z, m, s] = await Promise.all([
    pool.query<{ actorId: string; kanal: string; testZahlung: boolean }>(`SELECT "actorId", kanal, "testZahlung" FROM "KanalZugang"`),
    pool.query<{ muster: string }>(`SELECT muster FROM "TestAdressMuster"`),
    pool.query<{ routing: boolean }>(`SELECT routing FROM "StagingSchalter" WHERE id = 1`),
  ]);
  stand = {
    zugang: new Map(z.rows.map((r) => [r.actorId, { kanal: r.kanal === "staging" ? "staging" : "prod", testZahlung: r.testZahlung }])),
    muster: m.rows.map((r) => r.muster),
    routing: s.rows[0]?.routing ?? false,
    geladenAt: Date.now(),
  };
}

let gestartet = false;
/** Stand beim Start laden und alle 30 s auffrischen (Fehler: alter Stand bleibt). */
export function startKanalCache(pool: pg.Pool): void {
  if (gestartet) return;
  gestartet = true;
  const laden = () => kanalLaden(pool).catch((err) => logger.warn({ err: err instanceof Error ? err.message : String(err) }, "[kanal] Laden fehlgeschlagen"));
  void laden();
  setInterval(laden, 30_000).unref?.();
}

/**
 * Weiche an? Schalter in der Datenbank (Konsole), hart abschaltbar per STAGING_ROUTING=0 (dann
 * auf BEIDEN Gateways setzen, sonst laufen Kanal-Jobs doppelt).
 */
export function routingAktiv(): boolean {
  if (process.env.STAGING_ROUTING === "0") return false;
  return stand.routing;
}

/** Wirksamer Kanal eines Kontos: staging nur bei Eintrag UND eingeschalteter Weiche. */
export function kanalVon(actorId: string | null | undefined): Kanal {
  if (!actorId || !routingAktiv()) return "prod";
  return stand.zugang.get(actorId)?.kanal === "staging" ? "staging" : "prod";
}

/** Eingetragen, auch wenn die Weiche gerade aus ist (Anzeige in der Konsole). */
export const zugangVon = (actorId: string): Zugang | null => stand.zugang.get(actorId) ?? null;

/** Ist dieses Gateway für das Konto zuständig (Anfragen, Kanal-Jobs)? */
export function bedientKonto(actorId: string | null | undefined): boolean {
  return (gatewayRolle() === "staging") === (kanalVon(actorId) === "staging");
}

/** Glob mit * (sonst wörtlich), ohne Groß/klein, ganze Adresse. */
export function musterPasst(email: string, muster: string): boolean {
  const re = new RegExp(`^${muster.trim().toLowerCase().split("*").map((t) => t.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
  return re.test(email.trim().toLowerCase());
}

/** Passt die Adresse auf ein Test-Muster (dann wird das neue Konto ein Staging-Testkonto)? */
export function testAdresse(email: string | null | undefined): boolean {
  if (!email) return false;
  return stand.muster.some((m) => musterPasst(email, m));
}

/**
 * Erstes Anlegen eines Mitglieds: Test-Adresse → Kanal staging + Testzahlung, persönliche
 * Organisation im Stripe-Testmodus (nur solange sie keinen Stripe-Bezug hat). Idempotent.
 */
export async function testkontoBeiErstkontakt(q: Pick<pg.Pool, "query">, a: { actorId: string; tenantId: string; email: string | null }): Promise<boolean> {
  if (!testAdresse(a.email)) return false;
  await q.query(
    `INSERT INTO "KanalZugang" ("actorId", kanal, "testZahlung", email, notiz, von) VALUES ($1, 'staging', true, $2, 'Test-Adresse', 'muster')
     ON CONFLICT ("actorId") DO NOTHING`,
    [a.actorId, a.email],
  );
  if (a.tenantId === a.actorId) await zahlungsmodusTest(q, a.tenantId);
  return true;
}

/**
 * Test-Adresse beim allerersten Kontakt erkennen, egal welcher Weg zuerst kommt: Die Website
 * startet den Serverkauf direkt nach der Registrierung, noch bevor App oder Desktop /v1/whoami
 * rufen. Nur solange das Konto noch kein Mitglied ist (so bleibt ein Konto, das der Betreiber aus
 * Staging genommen hat, draußen). Trägt das Konto sofort ein (Datenbank + Stand im Speicher); den
 * Testmodus der persönlichen Organisation holt das Anlegen des Mitglieds nach.
 */
const keinTestkonto = new Map<string, number>();
export async function testkontoSicherstellen(q: Pick<pg.Pool, "query">, a: { actorId: string; email: string | null }): Promise<boolean> {
  if (stand.zugang.get(a.actorId)?.kanal === "staging") return true;
  if (!testAdresse(a.email)) return false;
  if ((keinTestkonto.get(a.actorId) ?? 0) > Date.now()) return false;
  const r = await q.query<{ drin: boolean }>(
    `WITH neu AS (
       INSERT INTO "KanalZugang" ("actorId", kanal, "testZahlung", email, notiz, von)
       SELECT $1, 'staging', true, $2, 'Test-Adresse', 'muster'
        WHERE NOT EXISTS (SELECT 1 FROM "TenantMember" WHERE "actorId" = $1)
       ON CONFLICT ("actorId") DO NOTHING
       RETURNING 1
     )
     SELECT EXISTS (SELECT 1 FROM neu) OR EXISTS (SELECT 1 FROM "KanalZugang" WHERE "actorId" = $1 AND kanal = 'staging') AS drin`,
    [a.actorId, a.email],
  );
  if (!r.rows[0]?.drin) {
    if (keinTestkonto.size > 2000) keinTestkonto.clear();
    keinTestkonto.set(a.actorId, Date.now() + 10 * 60_000);
    return false;
  }
  stand.zugang.set(a.actorId, { kanal: "staging", testZahlung: true });
  logger.info({ actorId: a.actorId }, "[kanal] Test-Adresse beim ersten Kontakt: Konto in Staging mit Testzahlung");
  return true;
}

/**
 * Staging-Gateway: Konto fehlt im Stand (bis zu 30 s alt), Prod leitet es aber schon weiter, weil
 * es gerade eingetragen wurde (Konsole, erster Kontakt). Einmal direkt nachsehen; Absagen
 * 30 s merken, damit fremde Konten nicht je Anfrage die Datenbank fragen.
 */
const nichtImStaging = new Map<string, number>();
export async function zugangNachladen(q: Pick<pg.Pool, "query">, actorId: string): Promise<boolean> {
  if (stand.zugang.get(actorId)?.kanal === "staging") return true;
  if ((nichtImStaging.get(actorId) ?? 0) > Date.now()) return false;
  const r = await q.query<{ kanal: string; testZahlung: boolean }>(`SELECT kanal, "testZahlung" FROM "KanalZugang" WHERE "actorId" = $1`, [actorId]);
  const z = r.rows[0];
  if (z?.kanal !== "staging") {
    if (nichtImStaging.size > 2000) nichtImStaging.clear();
    nichtImStaging.set(actorId, Date.now() + 30_000);
    return false;
  }
  stand.zugang.set(actorId, { kanal: "staging", testZahlung: z.testZahlung });
  return true;
}

/** Organisation auf Stripe-Testmodus — nie, wenn schon ein Stripe-Kunde/-Abo besteht. */
export async function zahlungsmodusTest(q: Pick<pg.Pool, "query">, tenantId: string): Promise<boolean> {
  const r = await q.query(
    `INSERT INTO "TenantBilling" ("tenantId", "stripeModus", "updatedAt") VALUES ($1, 'test', now())
     ON CONFLICT ("tenantId") DO UPDATE SET "stripeModus" = 'test', "updatedAt" = now()
       WHERE "TenantBilling"."stripeCustomerId" IS NULL AND "TenantBilling"."stripeSubscriptionId" IS NULL`,
    [tenantId],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Legt das Konto neue Organisationen im Testmodus an? */
export const testZahlungFuer = (actorId: string): boolean => stand.zugang.get(actorId)?.testZahlung === true;

// ---- Releases ------------------------------------------------------------------------------

export function versionVergleich(a: string, b: string): number {
  const x = a.replace(/^v/, "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  const y = b.replace(/^v/, "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

export interface ReleaseZeile { version: string; status: ReleaseStatus }

/**
 * Version, die ein Kanal bekommen soll, aus den vorhandenen Versionen (Registry/GitHub) und den
 * Release-Zeilen: prod = höchste freigegebene (alles bis zur höchsten freigegebenen gilt als
 * freigegeben, Altbestand); staging = höchste nicht verworfene.
 */
export function zielVersion(vorhanden: string[], zeilen: ReleaseZeile[], kanal: Kanal): string | null {
  const status = new Map(zeilen.map((z) => [z.version.replace(/^v/, ""), z.status]));
  const frei = zeilen.filter((z) => z.status === "freigegeben").map((z) => z.version.replace(/^v/, "")).sort(versionVergleich).at(-1) ?? null;
  const liste = [...new Set(vorhanden.map((v) => v.replace(/^v/, "")))].sort(versionVergleich);
  const passt = (v: string) => {
    const s = status.get(v);
    if (s === "verworfen") return false;
    if (kanal === "staging") return true;
    return s === "freigegeben" || (frei !== null && versionVergleich(v, frei) <= 0);
  };
  return liste.filter(passt).at(-1) ?? null;
}

export async function releasesLesen(pool: Pick<pg.Pool, "query">): Promise<ReleaseZeile[]> {
  const r = await pool.query<ReleaseZeile>(`SELECT version, status FROM "AvaRelease"`);
  return r.rows;
}

/** Versionen jenseits der höchsten freigegebenen, die noch keine Zeile haben (neue Kandidaten). */
export function neueKandidaten(vorhanden: string[], zeilen: ReleaseZeile[]): string[] {
  const bekannt = new Set(zeilen.map((z) => z.version.replace(/^v/, "")));
  const frei = zeilen.filter((z) => z.status === "freigegeben").map((z) => z.version.replace(/^v/, "")).sort(versionVergleich).at(-1) ?? "0.0.0";
  return [...new Set(vorhanden.map((v) => v.replace(/^v/, "")))].filter((v) => !bekannt.has(v) && versionVergleich(v, frei) > 0).sort(versionVergleich);
}

/** Neue Versionen (aus Registry oder GitHub) als Kandidaten vermerken. */
export async function kandidatenVermerken(pool: Pick<pg.Pool, "query">, versionen: string[], quelle: string): Promise<void> {
  for (const v of versionen) {
    await pool.query(
      `INSERT INTO "AvaRelease" (version, status, komponenten, von) VALUES ($1, 'kandidat', $2, 'automatisch')
       ON CONFLICT (version) DO UPDATE SET komponenten = "AvaRelease".komponenten || $2, "updatedAt" = now()
         WHERE NOT ("AvaRelease".komponenten ? $3)`,
      [v.replace(/^v/, ""), JSON.stringify({ [quelle]: true }), quelle],
    );
  }
}
