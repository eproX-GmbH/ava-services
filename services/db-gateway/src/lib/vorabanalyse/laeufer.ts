// Vorabanalyse Schritte 5 bis 7 je Firma: Website suchen + Judge, Miniprofil, ICP-Urteil.
// Ein Laeufer im Gateway-Prozess arbeitet gestartete Laeufe ab (SKIP LOCKED je Firma,
// Pakete, Parallelitaet aus den Einstellungen, Budgetbremse, Pause/Abbruch).

import { z } from "zod";
import type { Pool } from "pg";
import { logger } from "../logger";
import { betreiberJson } from "../betreiber-llm";
import { websiteLesen } from "./crawl";
import { kandidatenFiltern, valueserpSucheMitWiederholung } from "./suche";
import { ereignis, laufAendern, laufKosten, laufLesen, zaehlerAktualisieren, type Lauf } from "./store";
import type { Icp } from "./icp";

const judgeSchema = z.object({ matchIndex: z.number().int().nullable(), confidence: z.enum(["high", "medium", "low"]), reasoning: z.string().max(400).default("") });
// Grenzen werden gekuerzt, nicht abgelehnt (Modelle ueberschreiten Laengen gern knapp).
const kurz = (n: number) => z.string().default("").transform((v) => v.trim().slice(0, n));
const liste = (n: number, len: number) => z.array(z.string()).default([]).transform((a) => a.map((x) => x.trim().slice(0, len)).filter(Boolean).slice(0, n));
const profilSchema = z.object({
  branche: kurz(200), kurzbeschreibung: kurz(1200), leistungen: liste(15, 160), zielkunden: kurz(400), region: kurz(160), groessenIndiz: kurz(300), keywords: liste(20, 80),
});
const urteilSchema = z.object({ bewertungen: z.array(z.object({ id: z.string(), score: z.number().min(0).max(100), begruendung: z.string().max(400).default(""), ausschlussgrund: z.string().max(120).nullable().optional() })) });
type Profil = z.infer<typeof profilSchema>;

// medium liegt unter der Standardschwelle 0,7: nur sichere Urteile zaehlen als Website.
const KONFIDENZ: Record<"high" | "medium" | "low", number> = { high: 0.9, medium: 0.6, low: 0.3 };

const GENERISCH = new Set(["gmbh", "co", "kg", "ag", "ohg", "ug", "mbh", "und", "the", "der", "die", "das", "von", "fuer", "group", "gruppe", "holding", "international", "deutschland", "germany", "service", "services", "systems", "system", "technik", "tube", "mill", "steel", "engineering", "industrie", "industries", "maschinen", "maschinenbau", "automotive", "automation", "solutions", "consulting", "software", "haftungsbeschraenkt"]);
/** Plausibilitaet: Domain oder Titel muss einen kennzeichnenden Namensbestandteil tragen. */
function namePasst(firmenname: string, domain: string, titel: string): boolean {
  const norm = (x: string) => x.toLowerCase().replace(/ae|ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss");
  const tokens = norm(firmenname).split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !GENERISCH.has(t));
  if (tokens.length === 0) return true;
  const ziel = norm(`${domain} ${titel}`).replace(/-/g, "");
  return tokens.some((t) => ziel.includes(t) || (t.length >= 6 && ziel.includes(t.slice(0, 5))));
}
const aktive = new Map<string, { stop: boolean; pause: boolean }>();
let tickTimer: NodeJS.Timeout | null = null;

export function laeuferStarten(pool: Pool): void {
  if (tickTimer) return;
  const tick = async () => {
    try {
      const r = await pool.query<{ id: string }>(`SELECT "id" FROM "VorabLauf" WHERE "status" IN ('website', 'profil', 'urteil') AND "deletedAt" IS NULL`);
      for (const row of r.rows) if (!aktive.has(row.id)) void laufVerarbeiten(pool, row.id);
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "[vorab] Laeufer-Tick");
    }
  };
  tickTimer = setInterval(() => void tick(), 10_000);
  tickTimer.unref();
  void tick();
}

export function laufPausieren(id: string): void { const a = aktive.get(id); if (a) a.pause = true; }
export function laufStoppen(id: string): void { const a = aktive.get(id); if (a) a.stop = true; }
export function laufAktiv(id: string): boolean { return aktive.has(id); }

function icpText(icp: Icp): string {
  const z = (l: string[]) => (l.length ? l.join(", ") : "–");
  return [
    `Beschreibung: ${icp.beschreibung || "–"}`, `Angebot des Anbieters: ${icp.angebot || "–"}`, `Nutzen: ${icp.nutzen || "–"}`, `Zielbranchen: ${z(icp.branchen)}`,
    `Groesse: ${icp.groesse || "–"}`, `Orte/Regionen: ${z(icp.orte)}${icp.orte.length ? ` (Radius ${icp.radiusKm} km)` : ""}`, `Merkmale: ${z(icp.merkmale)}`, `Ausschluesse: ${icp.ausschluesse || "–"}`,
  ].join("\n");
}

function profilText(name: string, ort: string | null, p: Profil): string {
  return `${name}${ort ? ` (${ort})` : ""}; Branche: ${p.branche || "?"}; ${p.kurzbeschreibung}; Leistungen: ${p.leistungen.join(", ") || "?"}; Zielkunden: ${p.zielkunden || "?"}; Region: ${p.region || "?"}; Groesse: ${p.groessenIndiz || "?"}; Stichworte: ${p.keywords.join(", ")}`;
}

interface FirmaZeile { id: string; name: string; ort: string | null; plz: string | null; strasse: string | null; companyId: string | null; schritt: string; website: string | null; profil: Profil | null; kandidaten: Array<{ companyId: string; name: string; ort: string | null }> | null }

async function laufVerarbeiten(pool: Pool, laufId: string): Promise<void> {
  const steuer = { stop: false, pause: false };
  aktive.set(laufId, steuer);
  try {
    const lauf = await laufLesen(pool, laufId);
    if (!lauf || !lauf.icp) { await laufAendern(pool, laufId, { status: "fehler" }); await ereignis(pool, laufId, "website", "fehler", "Kein ICP hinterlegt."); return; }
    const icp = lauf.icp as unknown as Icp;
    const q = `vorab:${laufId}`;
    const e = lauf.einstellungen;
    let budgetGemeldet = false;
    // 1. Website + Judge, 2. Profil — je Firma sequenziell, N Firmen parallel.
    const arbeiter = Math.max(1, Math.min(20, e.parallelWebsite));
    let erledigt = 0;
    let letzteMeldung = Date.now();
    const naechste = async (): Promise<FirmaZeile | null> => {
      const r = await pool.query<FirmaZeile>(
        `UPDATE "VorabFirma" SET "gesperrtBis" = NOW() + INTERVAL '10 minutes' WHERE "id" = (
           SELECT "id" FROM "VorabFirma" WHERE "laufId" = $1 AND "duplikatVon" IS NULL AND "zuordnung" <> 'ausgeschlossen'
             AND ("schritt" IN ('eingelesen', 'abgeglichen') OR ("schritt" = 'website' AND "website" IS NOT NULL AND "profil" IS NULL))
             AND "fehler" IS NULL AND ("gesperrtBis" IS NULL OR "gesperrtBis" < NOW())
           ORDER BY "zeile" LIMIT 1 FOR UPDATE SKIP LOCKED)
         RETURNING "id", "name", "ort", "plz", "strasse", "companyId", "schritt", "website", "profil", "kandidaten"`,
        [laufId],
      );
      return r.rows[0] ?? null;
    };
    const fertig = async (id: string, patch: Record<string, unknown>) => {
      const keys = Object.keys(patch);
      const sets = keys.map((k, i) => `"${k}" = $${i + 2}${["websiteKandidaten", "websiteUrteil", "profil", "icpUrteil"].includes(k) ? "::jsonb" : ""}`).join(", ");
      await pool.query(`UPDATE "VorabFirma" SET ${sets}, "gesperrtBis" = NULL, "updatedAt" = NOW() WHERE "id" = $1`, [id, ...keys.map((k) => (typeof patch[k] === "object" && patch[k] !== null ? JSON.stringify(patch[k]) : patch[k]))]);
    };
    const firmaBearbeiten = async (f: FirmaZeile) => {
      // Website
      if (f.schritt !== "website") {
        const kand = f.kandidaten?.find((k) => k.companyId === f.companyId);
        const name = kand?.name ?? f.name;
        const ort = f.ort ?? kand?.ort ?? "";
        let treffer;
        let roh = 0;
        try {
          const r = await valueserpSucheMitWiederholung(pool, `${name} ${ort}`.trim(), q);
          roh = r.treffer.length;
          treffer = kandidatenFiltern(r.treffer);
        } catch (err) {
          await fertig(f.id, { fehler: `Websuche fehlgeschlagen: ${err instanceof Error ? err.message.slice(0, 160) : String(err)}`, versuche: 1 });
          return;
        }
        if (treffer.length === 0) { await fertig(f.id, { schritt: "website", websiteKandidaten: [], websiteUrteil: { passt: false, konfidenz: 1, begruendung: roh === 0 ? "Die Suche lieferte keine Treffer (drei Versuche)." : "Nur Plattformen und Verzeichnisse in den Treffern.", roh } }); return; }
        const prompt =
          `Du bekommst die Top-Suchergebnisse von Google zu einer Firma. Waehle EINEN Treffer als offizielle Unternehmens-Webseite oder antworte mit matchIndex: null.\n\n` +
          `Firmenname: ${name}${f.name !== name ? ` (im CRM: ${f.name})` : ""}\nStandort: ${[f.plz, ort].filter(Boolean).join(" ")}\n${f.strasse ? `Anschrift: ${f.strasse}\n` : ""}\nSuchergebnisse:\n` +
          treffer.map((c) => `[${c.index}] ${c.title}\n    URL: ${c.link}${c.snippet ? `\n    Snippet: ${c.snippet}` : ""}`).join("\n\n") +
          `\n\nRegeln:\n- Die Domain oder der Titel muss den Firmennamen oder seinen kennzeichnenden Teil tragen. Eine Seite, die nur zum ORT oder nur zur BRANCHE passt, ist IMMER falsch (z. B. ein Pflegeheim am selben Ort, ein Shop mit aehnlichen Produkten).\n- Konzernseiten zaehlen, wenn die Firma erkennbar zur Gruppe gehoert.\n- Verzeichnisse, Portale, Presse, Marktplaetze und soziale Netzwerke ausschliessen.\n- Gleicher Name, aber anderer Ort oder andere Rechtsform: null.\n- confidence high nur, wenn Name UND Ort oder Name UND eigene Domain zusammenpassen; medium bei plausibler, aber nicht belegter Zuordnung; im Zweifel null.\n- reasoning: EIN kurzer deutscher Satz.\n` +
          `Antworte NUR als JSON: {"matchIndex": <0..${treffer.length - 1}> | null, "confidence": "high"|"medium"|"low", "reasoning": "..."}`;
        const u = await betreiberJson({ system: "Du beurteilst, ob ein Suchergebnis die offizielle Website einer bestimmten Firma ist. Antworte nur als JSON.", user: prompt, schema: judgeSchema, quelle: q, maxTokens: 300 });
        if (!u.ok) { await fertig(f.id, { fehler: `Website-Judge: ${u.grund}`, websiteKandidaten: treffer }); return; }
        const idx = u.wert.matchIndex;
        const gewaehlt = idx != null && idx >= 0 && idx < treffer.length ? treffer[idx]! : null;
        let konf = KONFIDENZ[u.wert.confidence];
        let begruendung = u.wert.reasoning;
        // Plausibilitaet gegen Halluzinationen: ohne Namensbezug in Domain oder Titel keine Website.
        if (gewaehlt && !namePasst(name, gewaehlt.domain, gewaehlt.title)) { konf = Math.min(konf, 0.3); begruendung = `Verworfen: weder Domain noch Titel tragen den Firmennamen (${gewaehlt.domain}). ${begruendung}`; }
        const passt = !!gewaehlt && konf >= e.judgeKonfidenz;
        await fertig(f.id, { schritt: "website", website: passt ? gewaehlt!.link : null, websiteKandidaten: treffer, websiteUrteil: { passt, konfidenz: konf, begruendung, kandidat: gewaehlt?.link ?? null, roh } });
        if (!passt) return;
        f.website = gewaehlt!.link;
      }
      // Profil
      if (f.website && !f.profil) {
        const seite = await websiteLesen(f.website);
        if (!seite) { await fertig(f.id, { schritt: "profil", fehler: "Website nicht lesbar (nicht erreichbar, zu wenig Text oder Crawling untersagt)" }); return; }
        const p = await betreiberJson({
          system: "Du erstellst ein KOMPAKTES deutsches Firmen-Kurzprofil ausschliesslich auf Basis des mitgelieferten Website-Texts. Keine Vermutungen, KEINE Personennamen. " +
            'Antworte NUR als JSON: {"branche": "...", "kurzbeschreibung": "2-3 Saetze", "leistungen": ["..."], "zielkunden": "...", "region": "...", "groessenIndiz": "z. B. Teamgroesse/Standorte, falls erkennbar, sonst leer", "keywords": ["..."]}',
          user: `Firma: ${f.name}${f.ort ? ` (${f.ort})` : ""}\n\nWebsite-Text:\n${seite.text.slice(0, 24_000)}`, schema: profilSchema, quelle: q, maxTokens: 700,
        });
        if (!p.ok) { await fertig(f.id, { schritt: "profil", fehler: `Miniprofil: ${p.grund}` }); return; }
        await fertig(f.id, { schritt: "profil", profil: { ...p.wert, seiten: seite.seiten, url: seite.url } });
      }
    };
    // Phase A: Website + Profil parallel
    const worker = async () => {
      for (;;) {
        if (steuer.stop || steuer.pause) return;
        const f = await naechste();
        if (!f) return;
        try { await firmaBearbeiten(f); } catch (err) { await fertig(f.id, { fehler: `Unerwartet: ${err instanceof Error ? err.message.slice(0, 160) : String(err)}` }); }
        erledigt++;
        if (Date.now() - letzteMeldung > 30_000) {
          letzteMeldung = Date.now();
          await zaehlerAktualisieren(pool, laufId);
          const k = await laufKosten(pool, laufId);
          await ereignis(pool, laufId, "website", "fortschritt", `${erledigt} Firmen gesucht und profiliert · Kosten bisher ${k.gesamtUsd.toFixed(2)} USD.`);
          if (k.gesamtUsd >= e.budgetUsd && !budgetGemeldet) { budgetGemeldet = true; steuer.pause = true; await ereignis(pool, laufId, "website", "fehler", `Budgetbremse: ${k.gesamtUsd.toFixed(2)} USD erreicht (Limit ${e.budgetUsd} USD). Lauf pausiert; Limit erhöhen und fortsetzen.`); }
        }
      }
    };
    await ereignis(pool, laufId, "website", "info", `Website-Suche und Miniprofile gestartet (${arbeiter} parallel).`);
    await Promise.all(Array.from({ length: arbeiter }, () => worker()));
    await zaehlerAktualisieren(pool, laufId);
    if (steuer.stop) { await laufAendern(pool, laufId, { status: "abgebrochen" }); await ereignis(pool, laufId, "website", "info", "Lauf abgebrochen."); return; }
    if (steuer.pause) { await laufAendern(pool, laufId, { status: "pausiert" }); await ereignis(pool, laufId, "website", "info", "Lauf pausiert."); return; }
    // Phase B: ICP-Urteil in Paketen zu 10
    await laufAendern(pool, laufId, { status: "urteil" });
    await ereignis(pool, laufId, "urteil", "info", "ICP-Urteil gestartet.");
    const text = icpText(icp);
    for (;;) {
      if (steuer.stop || steuer.pause) break;
      const r = await pool.query<FirmaZeile & { profil: Profil }>(`SELECT "id", "name", "ort", "plz", "strasse", "companyId", "schritt", "website", "profil", "kandidaten" FROM "VorabFirma" WHERE "laufId" = $1 AND "schritt" = 'profil' AND "profil" IS NOT NULL AND "icpUrteil" IS NULL AND "fehler" IS NULL ORDER BY "zeile" LIMIT 10`, [laufId]);
      if (r.rows.length === 0) break;
      const u = await betreiberJson({
        system: "Du bewertest, wie gut Firmen zum Idealkundenprofil (ICP) eines B2B-Anbieters passen. Fuer JEDE Firma: score 0-100 (100 = perfekter Fit; unter 40 = kein Fit), EIN kurzer deutscher Satz als Begruendung, der konkret benennt, WARUM die Firma (nicht) passt, bezogen auf das ICP. Ausschluesse im ICP hart beruecksichtigen (Ausschluss getroffen → score unter 20 und ausschlussgrund nennen, z. B. \"Versicherung\", \"Behoerde\", \"falsche Branche\", \"zu klein\"). " +
          'Antworte NUR als JSON: {"bewertungen": [{"id": "...", "score": 0, "begruendung": "...", "ausschlussgrund": null}]}',
        user: `ICP:\n${text}\n\nFirmen:\n${r.rows.map((f) => `- id: ${f.id}\n  ${profilText(f.name, f.ort, f.profil).slice(0, 1200)}`).join("\n")}`, schema: urteilSchema, quelle: q, maxTokens: 1500,
      });
      if (!u.ok) { for (const f of r.rows) await fertig(f.id, { schritt: "urteil", fehler: `ICP-Urteil: ${u.grund}` }); continue; }
      for (const f of r.rows) {
        const b = u.wert.bewertungen.find((x) => x.id === f.id);
        if (!b) { await fertig(f.id, { schritt: "urteil", fehler: "ICP-Urteil: keine Bewertung erhalten" }); continue; }
        const score = Math.round(b.score);
        await fertig(f.id, { schritt: "urteil", icpUrteil: { score, passt: score >= e.mindestScore, begruendung: b.begruendung, ausschlussgrund: b.ausschlussgrund ?? null } });
      }
      await zaehlerAktualisieren(pool, laufId);
    }
    await zaehlerAktualisieren(pool, laufId);
    if (steuer.stop) { await laufAendern(pool, laufId, { status: "abgebrochen" }); return; }
    if (steuer.pause) { await laufAendern(pool, laufId, { status: "pausiert" }); return; }
    const k = await laufKosten(pool, laufId);
    const z = await zaehlerAktualisieren(pool, laufId);
    await laufAendern(pool, laufId, { status: "fertig" });
    await pool.query(`UPDATE "VorabLauf" SET "beendetAt" = NOW() WHERE "id" = $1`, [laufId]);
    await ereignis(pool, laufId, "ergebnis", "info", `Fertig: ${z.ready ?? 0} von ${z.gesamt ?? 0} Firmen AVA ready, ${z.website ?? 0} Websites, ${z.profil ?? 0} Profile, ${z.fehler ?? 0} Fehler. Kosten ${k.gesamtUsd.toFixed(2)} USD.`);
  } catch (err) {
    logger.error({ laufId, err: err instanceof Error ? err.message : String(err) }, "[vorab] Lauf abgebrochen");
    await ereignis(pool, laufId, "website", "fehler", `Lauf abgebrochen: ${err instanceof Error ? err.message : String(err)}`);
    await laufAendern(pool, laufId, { status: "fehler" });
  } finally {
    aktive.delete(laufId);
  }
}

/** ICP-Urteile verwerfen (nach ICP-Aenderung) und Lauf wieder in die Urteilsphase. */
export async function urteileZuruecksetzen(pool: Pool, laufId: string): Promise<void> {
  await pool.query(`UPDATE "VorabFirma" SET "icpUrteil" = NULL, "schritt" = CASE WHEN "profil" IS NOT NULL THEN 'profil' ELSE "schritt" END, "fehler" = CASE WHEN "fehler" LIKE 'ICP-Urteil%' THEN NULL ELSE "fehler" END WHERE "laufId" = $1`, [laufId]);
  await laufAendern(pool, laufId, { status: "urteil" });
}

export type { Lauf };

/** Fehlgeschlagene Zeilen erneut versuchen: Fehler loeschen, Schritt zurueck auf den letzten erledigten. */
export async function fehlerZuruecksetzen(pool: Pool, laufId: string): Promise<number> {
  const r = await pool.query(
    `UPDATE "VorabFirma" SET "fehler" = NULL, "versuche" = 0, "gesperrtBis" = NULL,
       "schritt" = CASE WHEN "icpUrteil" IS NOT NULL THEN 'urteil' WHEN "profil" IS NOT NULL THEN 'profil' WHEN "website" IS NOT NULL THEN 'website' WHEN "abgleich" IS NOT NULL THEN 'abgeglichen' ELSE 'eingelesen' END,
       "websiteUrteil" = CASE WHEN "website" IS NULL THEN NULL ELSE "websiteUrteil" END, "websiteKandidaten" = CASE WHEN "website" IS NULL THEN NULL ELSE "websiteKandidaten" END
     WHERE "laufId" = $1 AND "fehler" IS NOT NULL`,
    [laufId],
  );
  await ereignis(pool, laufId, "website", "info", `${r.rowCount ?? 0} fehlgeschlagene Zeilen werden erneut versucht.`);
  return r.rowCount ?? 0;
}

/** Website-Suche neu (verwirft Website, Profil und Urteil), fuer alle oder nur fuer Zeilen ohne Website. */
export async function websitesZuruecksetzen(pool: Pool, laufId: string, nurOhneWebsite: boolean): Promise<number> {
  const r = await pool.query(
    `UPDATE "VorabFirma" SET "website" = NULL, "websiteUrteil" = NULL, "websiteKandidaten" = NULL, "profil" = NULL, "icpUrteil" = NULL, "fehler" = NULL, "versuche" = 0, "gesperrtBis" = NULL,
       "schritt" = CASE WHEN "abgleich" IS NOT NULL THEN 'abgeglichen' ELSE 'eingelesen' END
     WHERE "laufId" = $1 AND "duplikatVon" IS NULL AND "zuordnung" <> 'ausgeschlossen' AND ($2::boolean = false OR "website" IS NULL)`,
    [laufId, nurOhneWebsite],
  );
  await ereignis(pool, laufId, "website", "info", nurOhneWebsite ? `Website-Suche für ${r.rowCount ?? 0} Zeilen ohne Website wird wiederholt.` : `Website-Suche für ${r.rowCount ?? 0} Zeilen wird neu gestartet.`);
  return r.rowCount ?? 0;
}
