// Firmen-Verflechtungen V4 (docs/PLAN_VERFLECHTUNGEN.md §4 Nr. 6, §8 Nr. 4/5):
// Rekursion ueber Firmen-Gesellschafter OHNE LLM im Gateway. Das Auslesen der
// Listen bleibt beim structured-content-Producer des Nutzers; hier laufen nur
// Buchhaltung und Ansto:
//
//   Liste kommt an  → Firmen-Gesellschafter zu companyIds aufloesen (Original-
//                     Regel wie im Register-Delta) → master-data speichert →
//                     Kontext bestimmen (offener Besuch oder neuer Wurzel-
//                     kontext) → Kinder in die Besuchsliste → master-data
//                     stoesst structured-content fuer den Nutzer an (Marker
//                     "verflechtungen": nur Register + Liste, keine Folge-
//                     Producer) → unbekannte Firmen: Register-Refresh und
//                     spaeter erneut anstossen (Cron).
//
// Notbremsen: automatischer Lauf je Pool-Firma eine Ebene (AUTO_TIEFE), auf
// Wunsch bis MAX_TIEFE Ebenen und MAX_FIRMEN Firmen je Kontext; `ohneBremse`
// hebt beide auf (grosse Konstrukte, ausdruecklich bestaetigt).

import type pg from "pg";
import { logger } from "./logger";
import { companyIdAus } from "./register-ids";
import { masterData, refreshAnfordern } from "./register-jobs";

export const AUTO_TIEFE = 1;
export const MAX_TIEFE = 6;
export const MAX_FIRMEN = 200;
/** Firmen ohne Registereintrag in master-data: so lange wird nachgezogen. */
const WARTE_TAGE = 14;
const NACHZIEH_MIN_ALTER_MS = 20 * 60_000;

type Q = { query: pg.Pool["query"] };

export type Firma = { companyId: string; gericht: string; art: string; nummer: string; zusatz: string; name: string };

type ListeRoh = { gesellschafter?: Array<Record<string, unknown>>; [k: string]: unknown };

/**
 * Firmen-Gesellschafter zur companyId aufloesen. Regel wie im Register-Delta
 * (`companyIdAus`): Gericht ohne "Amtsgericht", Art HRA/HRB, Nummer mit
 * optionalem Zusatz ("12345 B"). Was nicht eindeutig ist, bleibt ohne Id
 * (master-data behaelt die Zeile als Text, ohne Kante).
 */
export function loeseFirmenAuf(liste: ListeRoh): { liste: ListeRoh; firmen: Firma[] } {
  const firmen = new Map<string, Firma>();
  const zeilen = (liste.gesellschafter ?? []).map((g) => {
    if (g.typ !== "FIRMA") return g;
    const gericht = String(g.registerGericht ?? "").replace(/^\s*(Amtsgericht|AG)\s+/i, "").trim();
    const art = String(g.registerArt ?? "").toUpperCase().trim();
    const m = /^(\d{1,7})\s*([A-Z]{1,3})?$/i.exec(String(g.registerNummer ?? "").trim());
    if (!gericht || !/^HR[AB]$/.test(art) || !m) return { ...g, gesellschafterCompanyId: null };
    const nummer = String(Number(m[1]));
    const zusatz = (m[2] ?? "").toUpperCase();
    const companyId = companyIdAus(gericht, art, nummer, zusatz);
    firmen.set(companyId, { companyId, gericht, art, nummer, zusatz, name: String(g.name ?? "") });
    return { ...g, gesellschafterCompanyId: companyId };
  });
  return { liste: { ...liste, gesellschafter: zeilen }, firmen: [...firmen.values()] };
}

type Kontext = {
  kontext: string;
  tenantId: string;
  ursprungCompanyId: string;
  transactionId: string;
  quelleTransactionId: string | null;
  userId: string | null;
  maxTiefe: number;
  maxFirmen: number;
  ohneBremse: boolean;
};

type Anstoss = { userId?: string; angestossen: string[]; geparkt: string[]; unbekannt: string[] };

function kontextName(ursprungName: string | null, ursprungCompanyId: string): string {
  return `Verflechtungen ${ursprungName?.trim() || ursprungCompanyId}`.slice(0, 200);
}

async function ladeKontext(q: Q, kontext: string): Promise<Kontext | null> {
  const r = await q.query<Kontext>(`SELECT * FROM "VerflechtungKontext" WHERE "kontext" = $1`, [kontext]);
  return r.rows[0] ?? null;
}

/** master-data stoesst structured-content (Marker "verflechtungen") fuer den Nutzer an. */
async function anstossen(k: Kontext, companyIds: string[], ursprungName: string | null): Promise<Anstoss> {
  return masterData<Anstoss>("POST", "/internal/verflechtungen/anstossen", {
    tenantId: k.tenantId,
    userId: k.userId ?? undefined,
    quelleTransactionId: k.quelleTransactionId ?? undefined,
    transaction: { id: k.transactionId, name: kontextName(ursprungName, k.ursprungCompanyId) },
    companyIds,
  });
}

async function statusSetzen(q: Q, kontext: string, companyIds: string[], status: string, grund: string | null = null): Promise<void> {
  if (companyIds.length === 0) return;
  await q.query(
    `UPDATE "VerflechtungBesuch" SET "status" = $3, "grund" = $4, "aktualisiertAt" = NOW() WHERE "kontext" = $1 AND "companyId" = ANY($2::text[])`,
    [kontext, companyIds, status, grund],
  );
}

/** Ergebnis eines Anstosses in die Besuchsliste uebernehmen. */
async function anstossVerbuchen(q: Q, k: Kontext, a: Anstoss, firmen: Map<string, Firma>): Promise<void> {
  if (a.userId && !k.userId) await q.query(`UPDATE "VerflechtungKontext" SET "userId" = $2 WHERE "kontext" = $1`, [k.kontext, a.userId]);
  await statusSetzen(q, k.kontext, a.angestossen, "angestossen");
  await statusSetzen(q, k.kontext, a.geparkt, "geparkt", "Kontingent erschoepft");
  await statusSetzen(q, k.kontext, a.unbekannt, "wartetRegister", "Firma noch nicht in den Stammdaten");
  const refresh = a.unbekannt.map((id) => firmen.get(id)).filter((f): f is Firma => !!f && /^\d+$/.test(f.nummer));
  if (refresh.length > 0) {
    const n = await refreshAnfordern(q, refresh.map((f) => ({ gericht: f.gericht, art: f.art, nummer: Number(f.nummer), zusatz: f.zusatz, hinweis: f.name })), "verflechtungen", 1);
    logger.info({ kontext: k.kontext, firmen: refresh.length, jobs: n }, "[verflechtungen] Register-Refresh fuer unbekannte Firmen-Gesellschafter");
  }
}

/**
 * Nach einer gespeicherten Liste (oder KEINE/UNSICHER): Besuch abschliessen und
 * die Firmen-Gesellschafter als Kinder anstossen. Ohne offenen Besuch entsteht
 * ein Wurzelkontext mit AUTO_TIEFE (automatischer Lauf je Pool-Firma).
 */
export async function nachListe(
  q: Q,
  p: { tenantId: string; companyId: string; ursprungName: string | null; quelleTransactionId: string | null; firmen: Firma[]; ergebnis: "LISTE" | "KEINE" | "UNSICHER" },
): Promise<void> {
  // 1. Offener Besuch dieser Firma im Tenant?
  const offen = await q.query<{ kontext: string; tiefe: number }>(
    `SELECT b."kontext", b."tiefe" FROM "VerflechtungBesuch" b JOIN "VerflechtungKontext" k ON k."kontext" = b."kontext"
     WHERE b."companyId" = $1 AND k."tenantId" = $2 AND b."status" = 'angestossen' ORDER BY b."aktualisiertAt" DESC LIMIT 1`,
    [p.companyId, p.tenantId],
  );
  let k: Kontext | null;
  let tiefe: number;
  if (offen.rows[0]) {
    k = await ladeKontext(q, offen.rows[0].kontext);
    tiefe = offen.rows[0].tiefe;
    if (!k) return;
    await statusSetzen(q, k.kontext, [p.companyId], "erledigt", p.ergebnis === "LISTE" ? null : p.ergebnis);
  } else {
    if (p.ergebnis !== "LISTE" || p.firmen.length === 0) return; // nichts zu rekursieren
    const kontext = `${p.companyId}:${Date.now().toString(36)}`;
    k = {
      kontext,
      tenantId: p.tenantId,
      ursprungCompanyId: p.companyId,
      transactionId: `verflechtungen:${kontext}`,
      quelleTransactionId: p.quelleTransactionId,
      userId: null,
      maxTiefe: AUTO_TIEFE,
      maxFirmen: MAX_FIRMEN,
      ohneBremse: false,
    };
    tiefe = 0;
    await q.query(
      `INSERT INTO "VerflechtungKontext" ("kontext","tenantId","ursprungCompanyId","transactionId","quelleTransactionId","userId","maxTiefe","maxFirmen","ohneBremse")
       VALUES ($1,$2,$3,$4,$5,NULL,$6,$7,FALSE)`,
      [k.kontext, k.tenantId, k.ursprungCompanyId, k.transactionId, k.quelleTransactionId, k.maxTiefe, k.maxFirmen],
    );
    await q.query(`INSERT INTO "VerflechtungBesuch" ("kontext","companyId","tiefe","status") VALUES ($1,$2,0,'erledigt')`, [k.kontext, p.companyId]);
  }
  if (p.ergebnis !== "LISTE") return;

  // 2. Notbremsen
  const kinderTiefe = tiefe + 1;
  if (!k.ohneBremse && kinderTiefe > k.maxTiefe) {
    logger.info({ kontext: k.kontext, tiefe: kinderTiefe }, "[verflechtungen] Tiefengrenze erreicht");
    return;
  }
  const anzahl = Number((await q.query<{ n: string }>(`SELECT count(*)::text AS n FROM "VerflechtungBesuch" WHERE "kontext" = $1`, [k.kontext])).rows[0]?.n ?? 0);
  let budget = k.ohneBremse ? Number.MAX_SAFE_INTEGER : Math.max(0, k.maxFirmen - anzahl);

  // 3. Kinder in die Besuchsliste (jede Firma je Kontext nur einmal)
  const neu: Firma[] = [];
  for (const f of p.firmen) {
    if (budget <= 0) {
      logger.info({ kontext: k.kontext, companyId: f.companyId }, "[verflechtungen] Firmengrenze erreicht");
      break;
    }
    const r = await q.query(
      `INSERT INTO "VerflechtungBesuch" ("kontext","companyId","tiefe","status","gericht","art","nummer","zusatz")
       VALUES ($1,$2,$3,'offen',$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
      [k.kontext, f.companyId, kinderTiefe, f.gericht, f.art, f.nummer, f.zusatz],
    );
    if ((r.rowCount ?? 0) > 0) {
      neu.push(f);
      budget--;
    }
  }
  if (neu.length === 0) return;

  // 4. Anstossen
  try {
    const a = await anstossen(k, neu.map((f) => f.companyId), p.ursprungName);
    await anstossVerbuchen(q, k, a, new Map(neu.map((f) => [f.companyId, f])));
    logger.info({ kontext: k.kontext, tiefe: kinderTiefe, angestossen: a.angestossen.length, unbekannt: a.unbekannt.length, geparkt: a.geparkt.length }, "[verflechtungen] Kinder angestossen");
  } catch (err) {
    await statusSetzen(q, k.kontext, neu.map((f) => f.companyId), "geparkt", `Anstoss fehlgeschlagen: ${(err as Error).message}`.slice(0, 300));
    logger.warn({ kontext: k.kontext, err: (err as Error).message }, "[verflechtungen] Anstoss fehlgeschlagen, wird nachgezogen");
  }
}

/** Auf Wunsch (App, Chat): tieferer Lauf ab einer Firma; die Wurzel wird neu angestossen. */
export async function kontextAnlegen(
  q: Q,
  p: { tenantId: string; userId: string; companyId: string; ursprungName: string | null; maxTiefe?: number; ohneBremse?: boolean },
): Promise<{ kontext: string; transactionId: string; angestossen: boolean; unbekannt: boolean }> {
  const kontext = `${p.companyId}:${Date.now().toString(36)}`;
  const k: Kontext = {
    kontext,
    tenantId: p.tenantId,
    ursprungCompanyId: p.companyId,
    transactionId: `verflechtungen:${kontext}`,
    quelleTransactionId: null,
    userId: p.userId,
    maxTiefe: Math.min(Math.max(p.maxTiefe ?? MAX_TIEFE, 1), 12),
    maxFirmen: MAX_FIRMEN,
    ohneBremse: p.ohneBremse === true,
  };
  await q.query(
    `INSERT INTO "VerflechtungKontext" ("kontext","tenantId","ursprungCompanyId","transactionId","quelleTransactionId","userId","maxTiefe","maxFirmen","ohneBremse")
     VALUES ($1,$2,$3,$4,NULL,$5,$6,$7,$8)`,
    [k.kontext, k.tenantId, k.ursprungCompanyId, k.transactionId, k.userId, k.maxTiefe, k.maxFirmen, k.ohneBremse],
  );
  await q.query(`INSERT INTO "VerflechtungBesuch" ("kontext","companyId","tiefe","status") VALUES ($1,$2,0,'offen')`, [k.kontext, p.companyId]);
  const a = await anstossen(k, [p.companyId], p.ursprungName);
  await anstossVerbuchen(q, k, a, new Map());
  return { kontext, transactionId: k.transactionId, angestossen: a.angestossen.includes(p.companyId), unbekannt: a.unbekannt.includes(p.companyId) };
}

/** Stand eines Kontexts fuer App und Chat. */
export async function kontextStand(q: Q, tenantId: string, kontext: string): Promise<null | { kontext: Kontext; zaehler: Record<string, number>; besuche: Array<{ companyId: string; tiefe: number; status: string; grund: string | null }> }> {
  const k = await ladeKontext(q, kontext);
  if (!k || k.tenantId !== tenantId) return null;
  const r = await q.query<{ companyId: string; tiefe: number; status: string; grund: string | null }>(
    `SELECT "companyId","tiefe","status","grund" FROM "VerflechtungBesuch" WHERE "kontext" = $1 ORDER BY "tiefe", "companyId" LIMIT 1000`,
    [kontext],
  );
  const zaehler: Record<string, number> = {};
  for (const b of r.rows) zaehler[b.status] = (zaehler[b.status] ?? 0) + 1;
  return { kontext: k, zaehler, besuche: r.rows };
}

/** Kontexte einer Firma im Tenant (neueste zuerst). */
export async function kontexteVon(q: Q, tenantId: string, companyId: string): Promise<Array<Kontext & { erstelltAt: Date; offen: number; erledigt: number }>> {
  const r = await q.query<Kontext & { erstelltAt: Date; offen: string; erledigt: string }>(
    `SELECT k.*,
       (SELECT count(*) FROM "VerflechtungBesuch" b WHERE b."kontext" = k."kontext" AND b."status" IN ('offen','angestossen','wartetRegister','geparkt'))::text AS "offen",
       (SELECT count(*) FROM "VerflechtungBesuch" b WHERE b."kontext" = k."kontext" AND b."status" = 'erledigt')::text AS "erledigt"
     FROM "VerflechtungKontext" k WHERE k."tenantId" = $1 AND k."ursprungCompanyId" = $2 ORDER BY k."erstelltAt" DESC LIMIT 20`,
    [tenantId, companyId],
  );
  return r.rows.map((x) => ({ ...x, offen: Number(x.offen), erledigt: Number(x.erledigt) }));
}

/**
 * Cron: wartende (Register noch nicht da) und geparkte Besuche erneut anstossen;
 * nach WARTE_TAGE abbrechen. Laeuft stuendlich.
 */
export async function nachziehen(q: Q): Promise<{ angestossen: number; abgebrochen: number }> {
  const alt = new Date(Date.now() - WARTE_TAGE * 86_400_000);
  const ab = await q.query(
    `UPDATE "VerflechtungBesuch" SET "status" = 'abgebrochen', "grund" = COALESCE("grund",'') || ' (Frist abgelaufen)', "aktualisiertAt" = NOW()
     WHERE "status" IN ('wartetRegister','geparkt','offen') AND "aktualisiertAt" < $1`,
    [alt],
  );
  const faellig = await q.query<{ kontext: string; companyId: string }>(
    `SELECT "kontext","companyId" FROM "VerflechtungBesuch" WHERE "status" IN ('wartetRegister','geparkt','offen') AND "aktualisiertAt" < $1 ORDER BY "kontext" LIMIT 500`,
    [new Date(Date.now() - NACHZIEH_MIN_ALTER_MS)],
  );
  const jeKontext = new Map<string, string[]>();
  for (const f of faellig.rows) jeKontext.set(f.kontext, [...(jeKontext.get(f.kontext) ?? []), f.companyId]);
  let angestossen = 0;
  for (const [kontext, ids] of jeKontext) {
    const k = await ladeKontext(q, kontext);
    if (!k) continue;
    try {
      const a = await anstossen(k, ids, null);
      // Firmen ohne Registerdaten bleiben wartend (aktualisiertAt rueckt vor, damit die Frist zaehlt, aber nicht sofort erneut).
      await anstossVerbuchen(q, k, { ...a, unbekannt: [] }, new Map());
      await q.query(`UPDATE "VerflechtungBesuch" SET "aktualisiertAt" = NOW() WHERE "kontext" = $1 AND "companyId" = ANY($2::text[])`, [kontext, a.unbekannt]);
      angestossen += a.angestossen.length;
    } catch (err) {
      logger.warn({ kontext, err: (err as Error).message }, "[verflechtungen] Nachziehen fehlgeschlagen");
    }
  }
  return { angestossen, abgebrochen: ab.rowCount ?? 0 };
}

export function startVerflechtungenCron(pool: pg.Pool): void {
  if (process.env.VERFLECHTUNGEN_CRON_DISABLED === "1") return;
  const tick = async () => {
    try {
      const r = await nachziehen(pool);
      if (r.angestossen || r.abgebrochen) logger.info(r, "[verflechtungen] Nachziehen");
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "[verflechtungen] Cron-Tick fehlgeschlagen");
    }
  };
  setTimeout(() => {
    void tick();
    setInterval(() => void tick(), 60 * 60_000);
  }, 5 * 60_000);
}
