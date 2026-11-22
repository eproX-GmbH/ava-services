// Ein Cloud-Betrieb je Gateway-Prozess (die Sperre „ein Vorgang je Instanz“ lebt darin) und der
// Takt des Abgleichers (docs/PLAN_CLOUD_SELBSTBEDIENUNG.md Z2).

import { getGatewayPool } from "../producer-pools";
import { logger } from "../logger";
import { kontoSperre } from "../konto-loeschen";
import { betreiberBenachrichtigen } from "../problem-meldungen";
import { flyKunden, flyKundenEingerichtet } from "./fly-maschinen";
import { CloudBetrieb, pgRepo } from "./instanzen";
import { abgleichen, faktenAusDb, type AbgleichBericht } from "./abgleich";

let betrieb: CloudBetrieb | null = null;
export function cloudBetrieb(): CloudBetrieb {
  betrieb ??= new CloudBetrieb(pgRepo(getGatewayPool()), flyKunden);
  return betrieb;
}

const TAKT_MS = 5 * 60_000;
let laeuft: Promise<AbgleichBericht> | null = null;
let letzter: { at: string; bericht: AbgleichBericht } | null = null;
export const letzterAbgleich = () => letzter;

function deps() {
  const pool = getGatewayPool();
  return { repo: pgRepo(pool), fly: flyKunden, betrieb: cloudBetrieb(), fakten: faktenAusDb(pool, kontoSperre), melden: betreiberBenachrichtigen, warnen: (d: Record<string, unknown>, t: string) => logger.warn(d, t) };
}

/** Ein Lauf (oder nur eine Instanz); nie zwei Volllläufe gleichzeitig. */
export async function cloudAbgleich(nur?: string): Promise<AbgleichBericht> {
  if (process.env.CLOUD_ABGLEICH === "0") return { geprueft: 0, aktionen: { abgeschaltet: 1 }, fehler: 0, waisen: [] };
  if (!flyKundenEingerichtet()) return { geprueft: 0, aktionen: { nicht_eingerichtet: 1 }, fehler: 0, waisen: [] };
  if (!nur && laeuft) return laeuft;
  const p = abgleichen(deps(), nur);
  if (!nur) laeuft = p;
  try {
    const bericht = await p;
    if (!nur) letzter = { at: new Date().toISOString(), bericht };
    const taten = Object.entries(bericht.aktionen).filter(([a]) => a !== "nichts" && a !== "gesundheit");
    if (taten.length || bericht.fehler) logger.info({ ...bericht, nur }, "[cloud-abgleich] Lauf");
    return bericht;
  } finally {
    if (!nur) laeuft = null;
  }
}

/** Sofort nach einem Ereignis (Webhook, Admin-Aktion) für eine Instanz abgleichen. */
export function cloudAbgleichAnstossen(instanzId?: string): void {
  setImmediate(() => void cloudAbgleich(instanzId).catch((err) => logger.warn({ err: err instanceof Error ? err.message : String(err) }, "[cloud-abgleich] Anstoß fehlgeschlagen")));
}

export function startCloudAbgleich(): void {
  if (process.env.CLOUD_ABGLEICH === "0") { logger.info("[cloud-abgleich] aus (CLOUD_ABGLEICH=0)"); return; }
  if (!flyKundenEingerichtet()) { logger.info("[cloud-abgleich] nicht eingerichtet (FLY_KUNDEN_TOKEN fehlt)"); return; }
  const tick = () => void cloudAbgleich().catch((err) => logger.warn({ err: err instanceof Error ? err.message : String(err) }, "[cloud-abgleich] Lauf fehlgeschlagen"));
  setTimeout(tick, 60_000).unref?.();
  setInterval(tick, TAKT_MS).unref?.();
  logger.info("[cloud-abgleich] alle 5 Minuten, erster Lauf in 1 Minute");
}
