// Geschaeftsfuehrer-Rollen nachtragen (docs/PLAN_VERFLECHTUNGEN.md, V5).
//
// Befund vom 2026-09-20: Im Firmengeflecht fehlten die
// Geschaeftsfuehrungs-Kanten fast ueberall. 35.188 Firmen haben
// Geschaeftsfuehrer im structured-content, aber nur 571 eine Rolle in
// master-data — und nur aus dieser Rolle zeichnet das Netz die Kante.
//
// Es ist kein Denkfehler, sondern eine Nachtrag-Luecke: Die Spiegelung
// (spiegleStructuredContentNachMasterData) laeuft erst, seit V5 steht, und
// nur beim SPEICHERN von structured-content. Alles, was davor verarbeitet
// und seitdem nicht angefasst wurde, hat keine Rolle. Neu verarbeitete
// Firmen bekommen sie von allein — die alten nie.
//
// Dieser Nachtrag geht den Bestand einmal durch. Er nutzt denselben
// internen Endpunkt wie der Live-Pfad, statt die Personenzuordnung
// nachzubauen: Dieselbe Entdopplung, dieselbe Rollenpflege, dieselbe
// Schliessung veralteter Rollen. Ein zweiter Lauf ueber dieselbe Firma
// aendert deshalb nichts.
//
// Schonend: kleine Buendel im Minutentakt statt 35.000 Aufrufe am Stueck.
// Der Fortschritt steht in der Datenbank, ein Neustart setzt dort fort.
//
// GF_NACHTRAG_DISABLED=1 schaltet ab.

import { logger } from "./logger";
import { getGatewayPool, getProducerPool } from "./producer-pools";
import { masterData } from "./register-jobs";

/** Firmen je Durchgang. 200/Minute → der Bestand ist in gut drei Stunden durch. */
const JE_LAUF = 200;
const INTERVAL_MS = 60_000;

let timer: NodeJS.Timeout | null = null;
let laeuft = false;

async function ensureSchema(): Promise<void> {
  await getGatewayPool().query(`CREATE TABLE IF NOT EXISTS "GfRollenNachtrag" (
    "id"         INT PRIMARY KEY DEFAULT 1,
    "cursor"     TEXT NOT NULL DEFAULT '',
    "erledigt"   INT  NOT NULL DEFAULT 0,
    "fertigAt"   TIMESTAMPTZ,
    "updatedAt"  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT "GfRollenNachtrag_einzeilig" CHECK ("id" = 1)
  )`);
  await getGatewayPool().query(
    `INSERT INTO "GfRollenNachtrag" ("id") VALUES (1) ON CONFLICT ("id") DO NOTHING`,
  );
}

export async function runGfRollenNachtragOnce(): Promise<{ firmen: number; fertig: boolean }> {
  await ensureSchema();
  const pool = getGatewayPool();

  const stand = await pool.query<{ cursor: string; erledigt: number; fertigAt: Date | null }>(
    `SELECT "cursor", "erledigt", "fertigAt" FROM "GfRollenNachtrag" WHERE "id" = 1`,
  );
  if (stand.rows[0]?.fertigAt) return { firmen: 0, fertig: true };
  const cursor = stand.rows[0]?.cursor ?? "";

  // Firmen in stabiler Reihenfolge — der Cursor ist die zuletzt erledigte
  // companyId. Ohne feste Ordnung koennte ein Neustart Firmen ueberspringen.
  const sc = getProducerPool("structured-content");
  const firmen = await sc.query<{ companyId: string }>(
    `SELECT DISTINCT "companyId" FROM "ManagingDirector"
      WHERE "companyId" > $1
      ORDER BY "companyId" ASC
      LIMIT $2`,
    [cursor, JE_LAUF],
  );

  if (firmen.rows.length === 0) {
    await pool.query(
      `UPDATE "GfRollenNachtrag" SET "fertigAt" = NOW(), "updatedAt" = NOW() WHERE "id" = 1`,
    );
    logger.info({ erledigt: stand.rows[0]?.erledigt ?? 0 }, "[gf-nachtrag] Bestand vollstaendig nachgetragen");
    return { firmen: 0, fertig: true };
  }

  const ids = firmen.rows.map((r) => r.companyId);
  const personenRows = await sc.query<{
    companyId: string; firstName: string | null; lastName: string | null; birthDay: Date | null; city: string | null;
  }>(
    `SELECT "companyId", "firstName", "lastName", "birthDay", "city"
       FROM "ManagingDirector" WHERE "companyId" = ANY($1::text[])`,
    [ids],
  );

  const jeFirma = new Map<string, Array<Record<string, unknown>>>();
  for (const r of personenRows.rows) {
    if (!r.lastName?.trim()) continue;
    const liste = jeFirma.get(r.companyId) ?? [];
    liste.push({
      vorname: r.firstName ?? "",
      nachname: r.lastName,
      geburtsdatum: r.birthDay ? r.birthDay.toISOString().slice(0, 10) : null,
      wohnort: r.city ?? null,
    });
    jeFirma.set(r.companyId, liste);
  }

  let getan = 0;
  for (const companyId of ids) {
    const personen = jeFirma.get(companyId);
    // Firmen ohne verwertbaren Namen ueberspringen, aber den Cursor
    // weitersetzen — sonst bliebe der Nachtrag an ihnen haengen.
    if (!personen || personen.length === 0) continue;
    try {
      await masterData("POST", "/internal/companies/roles", {
        companyId,
        rolle: "GESCHAEFTSFUEHRER",
        personen,
        quelle: "nachtrag-structured-content",
      });
      getan++;
    } catch (err) {
      // Eine einzelne Firma darf den Durchgang nicht kippen; der Cursor
      // geht trotzdem weiter, sonst laeuft der Nachtrag ewig gegen
      // dieselbe kaputte Zeile.
      logger.warn(
        { companyId, err: err instanceof Error ? err.message : String(err) },
        "[gf-nachtrag] Firma uebersprungen",
      );
    }
  }

  const letzte = ids[ids.length - 1];
  await pool.query(
    `UPDATE "GfRollenNachtrag"
        SET "cursor" = $1, "erledigt" = "erledigt" + $2, "updatedAt" = NOW()
      WHERE "id" = 1`,
    [letzte, getan],
  );
  logger.info({ firmen: getan, cursor: letzte }, "[gf-nachtrag] Buendel nachgetragen");
  return { firmen: getan, fertig: false };
}

export function startGfRollenNachtrag(): void {
  if (process.env.GF_NACHTRAG_DISABLED === "1") {
    logger.info("[gf-nachtrag] abgeschaltet (GF_NACHTRAG_DISABLED=1)");
    return;
  }
  if (timer) return;
  const tick = async () => {
    if (laeuft) return;
    laeuft = true;
    try {
      const r = await runGfRollenNachtragOnce();
      if (r.fertig && timer) {
        clearInterval(timer);
        timer = null;
      }
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "[gf-nachtrag] Durchgang fehlgeschlagen",
      );
    } finally {
      laeuft = false;
    }
  };
  timer = setInterval(() => void tick(), INTERVAL_MS);
  timer.unref?.();
  // Erster Lauf nach zwei Minuten: Der Start soll nicht mit dem uebrigen
  // Hochfahren konkurrieren.
  setTimeout(() => void tick(), 120_000).unref?.();
}
