// Vorabanalyse Schritt 3/4: Stammdaten-Abgleich (master-data data-care/rows in
// Paketen) und Zuordnung (manuell, Best Match, Ausschluss).

import type { Pool } from "pg";
import { masterData } from "../register-jobs";
import { logger } from "../logger";
import { ereignis, laufAendern, laufLesen, zaehlerAktualisieren } from "./store";
import { crmNameBereinigen, kennzeichen, namenUeberlappen } from "./namen";

interface AbgleichZeile {
  name: string; location: string; status: "treffer" | "unsicher" | "keiner"; companyId: string | null; companyName?: string; companyLocation?: string; historie?: boolean;
  kandidaten: Array<{ companyId: string; name: string; location: string; score: number }>;
}

const laufend = new Set<string>();
const PAKET = 150;

export function abgleichLaeuft(laufId: string): boolean {
  return laufend.has(laufId);
}

function landAus(land: string | null): "DE" | "AT" | "CH" | "UK" {
  const l = (land ?? "").trim().toUpperCase();
  if (["AT", "A", "AUT", "ÖSTERREICH", "OESTERREICH", "AUSTRIA"].includes(l)) return "AT";
  if (["CH", "CHE", "SCHWEIZ", "SWITZERLAND", "SUISSE", "SVIZZERA"].includes(l)) return "CH";
  if (["UK", "GB", "GBR", "ENGLAND", "UNITED KINGDOM", "GROSSBRITANNIEN", "GROßBRITANNIEN"].includes(l)) return "UK";
  return "DE";
}

/** Abgleich im Hintergrund starten; Fortschritt ueber Zaehler und Ereignisse. */
export function abgleichStarten(pool: Pool, laufId: string): void {
  if (laufend.has(laufId)) return;
  laufend.add(laufId);
  void (async () => {
    try {
      await laufAendern(pool, laufId, { status: "abgleich" });
      await pool.query(`UPDATE "VorabLauf" SET "gestartetAt" = COALESCE("gestartetAt", NOW()) WHERE "id" = $1`, [laufId]);
      await ereignis(pool, laufId, "abgleich", "info", "Abgleich mit den Stammdaten gestartet.");
      let gesamt = 0;
      let treffer = 0;
      let unsicher = 0;
      let keiner = 0;
      for (;;) {
        const r = await pool.query<{ id: string; name: string; ort: string | null; plz: string | null; land: string | null }>(
          `SELECT "id", "name", "ort", "plz", "land" FROM "VorabFirma" WHERE "laufId" = $1 AND "duplikatVon" IS NULL AND "abgleich" IS NULL ORDER BY "zeile" LIMIT $2`,
          [laufId, PAKET],
        );
        if (r.rows.length === 0) break;
        const ohneOrt = r.rows.filter((x) => !x.ort);
        for (const x of ohneOrt) await pool.query(`UPDATE "VorabFirma" SET "abgleich" = 'keiner', "kandidaten" = '[]'::jsonb, "fehler" = 'Kein Ort in der Zeile', "updatedAt" = NOW() WHERE "id" = $1`, [x.id]);
        const mitOrt = r.rows.filter((x) => x.ort);
        // je Land ein Aufruf
        const gruppen = new Map<string, typeof mitOrt>();
        for (const x of mitOrt) { const l = landAus(x.land); gruppen.set(l, [...(gruppen.get(l) ?? []), x]); }
        for (const [country, zeilen] of gruppen) {
          let antwort: { rows: AbgleichZeile[] };
          try {
            antwort = await masterData<{ rows: AbgleichZeile[] }>("POST", "/internal/data-care/rows", { country, rows: zeilen.map((x) => ({ name: crmNameBereinigen(x.name), location: x.ort })) });
          } catch (err) {
            const g = err instanceof Error ? err.message : String(err);
            logger.warn({ laufId, err: g }, "[vorab] Abgleich-Paket fehlgeschlagen");
            await ereignis(pool, laufId, "abgleich", "fehler", `Paket fehlgeschlagen: ${g}`);
            for (const x of zeilen) await pool.query(`UPDATE "VorabFirma" SET "abgleich" = 'keiner', "fehler" = $2, "updatedAt" = NOW() WHERE "id" = $1`, [x.id, `Abgleich fehlgeschlagen: ${g.slice(0, 200)}`]);
            continue;
          }
          for (const x of zeilen) {
            let z = antwort.rows.find((a) => a.name.toLowerCase() === crmNameBereinigen(x.name).toLowerCase() && a.location.toLowerCase() === (x.ort ?? "").trim().toLowerCase());
            if (!z) { keiner++; await pool.query(`UPDATE "VorabFirma" SET "abgleich" = 'keiner', "kandidaten" = '[]'::jsonb, "updatedAt" = NOW() WHERE "id" = $1`, [x.id]); continue; }
            // 2026-10-23 (Befund Patrick, FMB-Liste): Kandidaten nach Namensbezug ordnen,
            // nicht nach dem rohen Suchwert — Rechtsform und Ort zaehlen nicht als Name.
            // Gleiche Kennzeichen und gleicher Ort ("Anton Vogt GmbH" ↔ "Anton Vogt
            // GmbH & Co.KG", beide Geseke) sind ein Treffer, keine Rueckfrage.
            const kand = kandidatenOrdnen(x.name, x.ort, z.kandidaten);
            const sicher = kand.find((k) => k.namensbezug >= 1 && k.ortGleich);
            if (z.status === "unsicher" && sicher) {
              z = { ...z, status: "treffer", companyId: sicher.companyId, companyName: sicher.name, companyLocation: sicher.ort, historie: false };
            }
            if (z.status === "treffer" && z.companyId) {
              treffer++;
              await pool.query(`UPDATE "VorabFirma" SET "abgleich" = 'treffer', "kandidaten" = $2::jsonb, "companyId" = $3, "zuordnung" = 'automatisch', "schritt" = 'abgeglichen', "updatedAt" = NOW() WHERE "id" = $1`,
                [x.id, JSON.stringify([{ companyId: z.companyId, name: z.companyName ?? z.name, ort: z.companyLocation ?? z.location, score: 1, historie: z.historie ?? false }]), z.companyId]);
            } else if (z.status === "unsicher") {
              unsicher++;
              await pool.query(`UPDATE "VorabFirma" SET "abgleich" = 'unsicher', "kandidaten" = $2::jsonb, "schritt" = 'abgeglichen', "updatedAt" = NOW() WHERE "id" = $1`, [x.id, JSON.stringify(kand)]);
            } else {
              keiner++;
              await pool.query(`UPDATE "VorabFirma" SET "abgleich" = 'keiner', "kandidaten" = '[]'::jsonb, "schritt" = 'abgeglichen', "updatedAt" = NOW() WHERE "id" = $1`, [x.id]);
            }
          }
        }
        gesamt += r.rows.length;
        await zaehlerAktualisieren(pool, laufId);
        await ereignis(pool, laufId, "abgleich", "fortschritt", `${gesamt} Zeilen abgeglichen (${treffer} Treffer, ${unsicher} unsicher, ${keiner} ohne Treffer).`);
      }
      await laufAendern(pool, laufId, { status: "zuordnung" });
      await zaehlerAktualisieren(pool, laufId);
      await ereignis(pool, laufId, "abgleich", "info", `Abgleich fertig: ${treffer} Treffer, ${unsicher} unsicher, ${keiner} ohne Treffer.`);
    } catch (err) {
      const g = err instanceof Error ? err.message : String(err);
      logger.error({ laufId, err: g }, "[vorab] Abgleich abgebrochen");
      await ereignis(pool, laufId, "abgleich", "fehler", `Abgleich abgebrochen: ${g}`);
      await laufAendern(pool, laufId, { status: "fehler" });
    } finally {
      laufend.delete(laufId);
    }
  })();
}

function normOrt(o: string | null | undefined): string {
  return (o ?? "").toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss").replace(/[^a-z0-9]+/g, " ").trim();
}

/** Kandidaten nach Namensbezug (Anteil gemeinsamer Kennzeichen, beidseitig) und Ort ordnen;
 *  ohne jeden Namensbezug fliegen sie heraus, sobald es bessere gibt. */
export function kandidatenOrdnen(
  crmName: string,
  crmOrt: string | null,
  roh: Array<{ companyId: string; name: string; location: string; score: number }>,
): Array<{ companyId: string; name: string; ort: string; score: number; namensbezug: number; ortGleich: boolean }> {
  const kz = kennzeichen(crmName, crmOrt);
  const ortN = normOrt(crmOrt);
  const bewertet = roh.map((k) => {
    const kk = kennzeichen(k.name, k.location);
    const gemeinsam = kz.filter((t) => kk.includes(t) || kk.some((u) => u.length >= 6 && t.length >= 6 && (u.startsWith(t.slice(0, 5)) || t.startsWith(u.slice(0, 5))))).length;
    // beidseitig: Anteil an den CRM-Kennzeichen UND an den Kandidaten-Kennzeichen
    const namensbezug = kz.length === 0 || kk.length === 0 ? 0 : Math.min(gemeinsam / kz.length, gemeinsam / kk.length);
    const ortGleich = ortN.length > 0 && normOrt(k.location) === ortN;
    const score = Math.round((namensbezug * 100 + (ortGleich ? 20 : 0) + Math.min(10, (k.score ?? 0) / 5)) * 100) / 100;
    return { companyId: k.companyId, name: k.name, ort: k.location, score, namensbezug, ortGleich };
  });
  const mitBezug = bewertet.filter((k) => k.namensbezug > 0);
  return (mitBezug.length > 0 ? mitBezug : bewertet).sort((a, b) => b.score - a.score).slice(0, 5);
}

/** Abgleich zuruecksetzen (z. B. nach neuer Datei). */
export async function abgleichZuruecksetzen(pool: Pool, laufId: string): Promise<void> {
  await pool.query(`UPDATE "VorabFirma" SET "abgleich" = NULL, "kandidaten" = NULL, "companyId" = NULL, "zuordnung" = 'offen', "schritt" = CASE WHEN "duplikatVon" IS NULL THEN 'eingelesen' ELSE 'duplikat' END, "fehler" = NULL WHERE "laufId" = $1`, [laufId]);
}

export async function zuordnen(pool: Pool, laufId: string, firmaId: number, wahl: { companyId: string | null; ausschliessen?: boolean }): Promise<boolean> {
  const r = await pool.query<{ kandidaten: Array<{ companyId: string; name: string; ort: string | null }> | null }>(`SELECT "kandidaten" FROM "VorabFirma" WHERE "id" = $1 AND "laufId" = $2`, [firmaId, laufId]);
  if (!r.rows[0]) return false;
  if (wahl.ausschliessen) {
    await pool.query(`UPDATE "VorabFirma" SET "zuordnung" = 'ausgeschlossen', "companyId" = NULL, "updatedAt" = NOW() WHERE "id" = $1`, [firmaId]);
  } else if (wahl.companyId) {
    await pool.query(`UPDATE "VorabFirma" SET "zuordnung" = 'manuell', "companyId" = $2, "updatedAt" = NOW() WHERE "id" = $1`, [firmaId, wahl.companyId]);
  } else {
    // Ohne Registerfirma weiter (Website-Suche laeuft trotzdem).
    await pool.query(`UPDATE "VorabFirma" SET "zuordnung" = 'manuell', "companyId" = NULL, "updatedAt" = NOW() WHERE "id" = $1`, [firmaId]);
  }
  return true;
}

/** Best Match fuer alle offenen unsicheren Zeilen: hoechster Kandidat ab Mindestscore. */
export async function bestMatch(pool: Pool, laufId: string, mindestScore: number): Promise<{ zugeordnet: number; offenGeblieben: number }> {
  const lauf = await laufLesen(pool, laufId);
  if (!lauf) return { zugeordnet: 0, offenGeblieben: 0 };
  const r = await pool.query<{ id: string; name: string; ort: string | null; kandidaten: Array<{ companyId: string; name: string; score: number }> }>(`SELECT "id", "name", "ort", "kandidaten" FROM "VorabFirma" WHERE "laufId" = $1 AND "abgleich" = 'unsicher' AND "zuordnung" = 'offen'`, [laufId]);
  let zugeordnet = 0;
  let offen = 0;
  // Fuzzy-Scores sind Elasticsearch-Scores (nicht 0..1): Schwelle relativ zum besten
  // Treffer je Zeile und absolut >= 0.8 * bester Score der Zeile; mindestScore 0..1 wirkt
  // als Abstand zum zweiten Kandidaten (Eindeutigkeit).
  for (const row of r.rows) {
    // Nur Kandidaten, die einen kennzeichnenden Namensbestandteil mit der CRM-Zeile teilen
    // (sonst nimmt die Fuzzy-Suche z. B. "A.I. Fitness" fuer "CT Formteile").
    const k = (row.kandidaten ?? []).filter((c) => namenUeberlappen(row.name, c.name, row.ort)).sort((a, b) => b.score - a.score);
    const best = k[0];
    const zweiter = k[1];
    const eindeutig = best && (!zweiter || zweiter.score <= best.score * (1 - (1 - mindestScore) * 0.5));
    if (best && eindeutig) {
      await pool.query(`UPDATE "VorabFirma" SET "zuordnung" = 'bestmatch', "companyId" = $2, "updatedAt" = NOW() WHERE "id" = $1`, [row.id, best.companyId]);
      zugeordnet++;
    } else offen++;
  }
  await ereignis(pool, laufId, "zuordnung", "info", `Best Match: ${zugeordnet} zugeordnet, ${offen} bleiben offen (zu knapp zwischen den Kandidaten).`);
  await zaehlerAktualisieren(pool, laufId);
  return { zugeordnet, offenGeblieben: offen };
}

/** Alle offenen unsicheren Zeilen auf einmal: ohne Registerfirma weiterfuehren oder ausschliessen. */
export async function alleOffenenZuordnen(pool: Pool, laufId: string, aktion: "ohne-register" | "ausschliessen"): Promise<number> {
  const r = await pool.query(
    aktion === "ausschliessen"
      ? `UPDATE "VorabFirma" SET "zuordnung" = 'ausgeschlossen', "companyId" = NULL, "updatedAt" = NOW() WHERE "laufId" = $1 AND "abgleich" = 'unsicher' AND "zuordnung" = 'offen'`
      : `UPDATE "VorabFirma" SET "zuordnung" = 'manuell', "companyId" = NULL, "updatedAt" = NOW() WHERE "laufId" = $1 AND "abgleich" = 'unsicher' AND "zuordnung" = 'offen'`,
    [laufId],
  );
  const n = r.rowCount ?? 0;
  await ereignis(pool, laufId, "zuordnung", "info", aktion === "ausschliessen" ? `${n} offene Zeilen ausgeschlossen.` : `${n} offene Zeilen ohne Registerfirma übernommen.`);
  await zaehlerAktualisieren(pool, laufId);
  return n;
}
