// Onboarding O10 (docs/PLAN_ONBOARDING.md): Radar-Kurzprofil als Ersatz auf der
// Firmenseite, solange die echte Verarbeitung (Profil-Producer) noch nichts geliefert hat.
//
// Joyce 2026-11-08: Nur bei sicherer Zuordnung, nie wegen eines gleichen Namens.
// Der Radar hat dafuer kein eigenes Feld (masterCompanyId entsteht unscharf), also
// wird beim Anzeigen streng geprueft:
//   1. genau EIN Radar-Kandidat zeigt auf diese companyId (mit Mini-Profil),
//   2. im Register gibt es am Ort genau EINE Firma mit diesem Namen,
//   3. Radar-Name und Register-Name passen zueinander (kennzeichnender Bestandteil),
//      und der Ort des Kandidaten ist der Registerort.
// Die Website zeigt der Ersatz nur, wenn die Domain den Firmennamen traegt.

import type { Pool } from "pg";
import { getMasterDataPool } from "./discovery";
import { getGatewayPool } from "./producer-pools";
import { kennzeichen, namePasst } from "./vorabanalyse/namen";
import { logger } from "./logger";

export interface RadarErsatz {
  profil: string;
  url: string | null;
  keywords: string[];
  stand: string;
}

interface Profil {
  branche?: string; kurzbeschreibung?: string; leistungen?: string[]; zielkunden?: string;
  region?: string; groessenIndiz?: string; keywords?: string[];
}

const CACHE_MS = 30 * 60_000;
const cache = new Map<string, { bis: number; wert: RadarErsatz | null }>();

function normOrt(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss").replace(/\s*\(.*\)\s*$/, "").replace(/[^a-z0-9]+/g, " ").trim();
}

function normName(s: string): string {
  return s.toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
    .replace(/\b(gmbh|ag|kg|se|ug|ohg|mbh|co|haftungsbeschraenkt|e\s?k|ev|e\s?v|gbr|ltd|limited|sa|sarl|plc|inc|llc)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ").trim();
}

function markdown(p: Profil): string {
  const teile: string[] = [];
  if (p.kurzbeschreibung) teile.push(p.kurzbeschreibung.trim());
  if (p.branche) teile.push(`**Branche:** ${p.branche}`);
  if (p.leistungen?.length) teile.push(`**Leistungen:** ${p.leistungen.join(", ")}`);
  if (p.zielkunden) teile.push(`**Zielkunden:** ${p.zielkunden}`);
  if (p.groessenIndiz) teile.push(`**Größe:** ${p.groessenIndiz}`);
  if (p.region) teile.push(`**Region:** ${p.region}`);
  return teile.join("\n\n");
}

/** Ersatz nur bei sicherer Zuordnung, sonst null (Seite bleibt wie ohne Profil). */
export async function radarErsatz(companyId: string, pools: { gateway?: Pool; register?: Pool } = {}): Promise<RadarErsatz | null> {
  const c = cache.get(companyId);
  if (c && c.bis > Date.now()) return c.wert;
  let wert: RadarErsatz | null = null;
  try {
    wert = await pruefen(companyId, pools.gateway ?? getGatewayPool(), pools.register ?? getMasterDataPool());
  } catch (err) {
    logger.warn({ companyId, err: err instanceof Error ? err.message : String(err) }, "[radar-ersatz] Pruefung fehlgeschlagen");
    return null;
  }
  cache.set(companyId, { bis: Date.now() + CACHE_MS, wert });
  return wert;
}

async function pruefen(companyId: string, gateway: Pool, register: Pool): Promise<RadarErsatz | null> {
  // 1. genau ein Radar-Kandidat fuer diese Firma
  const k = await gateway.query<{ discoveryId: string; name: string; city: string | null; profileJson: Profil | null; profiledAt: Date | null }>(
    `SELECT "discoveryId", "name", "city", "profileJson", "profiledAt" FROM "DiscoveredCompany" WHERE "masterCompanyId" = $1 LIMIT 2`,
    [companyId],
  );
  if (k.rows.length !== 1) return null;
  const kand = k.rows[0]!;
  if (!kand.profileJson || !kand.profiledAt) return null;
  const p = kand.profileJson;
  if (!p.kurzbeschreibung && !p.branche && !(p.leistungen?.length)) return null;

  // 3. Register-Eintrag: Name und Ort muessen zum Kandidaten passen
  const r = await register.query<{ name: string; location: string | null; country: string | null }>(
    `SELECT name, location, country FROM "GermanCompany" WHERE "companyId" = $1 LIMIT 1`,
    [companyId],
  );
  const reg = r.rows[0];
  if (!reg?.name || !reg.location) return null;
  if (!kand.city || normOrt(kand.city) !== normOrt(reg.location)) return null;
  const kennKand = kennzeichen(kand.name, kand.city);
  const kennReg = kennzeichen(reg.name, reg.location);
  if (kennKand.length === 0 || kennReg.length === 0) return null;
  if (!namePasst(reg.name, reg.location, kand.name) || !namePasst(kand.name, kand.city, reg.name)) return null;

  // 2. am Registerort genau eine Firma mit diesem Namen (ohne Rechtsform verglichen)
  const kern = normName(reg.name);
  if (kern.length < 3) return null;
  const leitwort = kennReg.slice().sort((a, b) => b.length - a.length)[0]!;
  const gleiche = await register.query<{ name: string }>(
    `SELECT name FROM "GermanCompany"
      WHERE country = $1 AND location = $2
        AND replace(replace(replace(replace(lower(name), 'ä', 'ae'), 'ö', 'oe'), 'ü', 'ue'), 'ß', 'ss') LIKE $3
      LIMIT 50`,
    [reg.country ?? "DE", reg.location, `%${leitwort.replace(/[%_]/g, "")}%`],
  );
  const gleichNamig = gleiche.rows.filter((g) => normName(g.name) === kern).length;
  if (gleichNamig !== 1) return null;

  // Website nur, wenn die Domain den Firmennamen traegt
  const domain = kand.discoveryId;
  const url = namePasst(reg.name, reg.location, domain) ? `https://${domain}` : null;
  return { profil: markdown(p), url, keywords: (p.keywords ?? []).slice(0, 12), stand: kand.profiledAt!.toISOString() };
}
