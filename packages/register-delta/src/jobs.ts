// Ausfuehrung eines geleasten Jobs gegen das Portal. Rein auf den
// Schnittstellen (Portal, Taktgeber) definiert, damit sie sich mit Attrappen
// testen laesst (jobs.test.ts).

import type { Ergebnis, Job, TrefferMeldung } from "./gateway-client";
import { parseBekanntmachungen, type Treffer } from "./parser";
import type { Suchergebnis } from "./portal";

export type PortalSchnittstelle = {
  suche(gericht: string, art: string, nummer: number | string): Promise<Suchergebnis>;
  bekanntmachungenText(): Promise<{ gesperrt: boolean; text: string }>;
};

export type TaktSchnittstelle = { warten(): Promise<void>; frei(): number };

export type AusfuehrungsOptionen = {
  workerId: string;
  portal: PortalSchnittstelle;
  takt: TaktSchnittstelle;
  /** Hoechstzahl Abfragen je Job; muss in die Lease (20 min) passen. */
  maxAbfragenJeJob?: number;
  log?: (zeile: string) => void;
  /** Abbruchsignal (Desktop: Nutzer pausiert, Akku, Chat aktiv). */
  abbrechen?: () => boolean;
};

export const MAX_ABFRAGEN_JE_JOB = 15;

export function trefferZuMeldung(t: Treffer, gerichtFallback?: string): TrefferMeldung {
  return {
    gericht: t.gericht || gerichtFallback || "",
    art: t.art,
    nummer: t.nummer,
    zusatz: t.zusatz,
    frueher: t.frueher,
    bundesland: t.bundesland,
    name: t.name,
    sitz: t.sitz,
    status: t.status,
    historie: t.historie,
  };
}

type FrontPayload = { gericht: string; art: string; abNummer: number; maxFehltreffer?: number; offeneLuecken?: number[]; zusaetze?: string[] };
type RefreshPayload = { firmen: Array<{ gericht: string; art: string; nummer: number; zusatz?: string; hinweis?: string }>; grund?: string };
type BekPayload = { tag: string };

export async function fuehreJobAus(job: Job, o: AusfuehrungsOptionen): Promise<Ergebnis> {
  const log = o.log ?? (() => {});
  const max = o.maxAbfragenJeJob ?? MAX_ABFRAGEN_JE_JOB;
  const basis: Ergebnis = { workerId: o.workerId, abfragen: 0, treffer: [] };

  if (job.art === "front") {
    const p = job.payload as unknown as FrontPayload;
    const maxFehl = p.maxFehltreffer ?? 10;
    let hoechsteMitTreffer = p.abNummer - 1;
    const luecken: number[] = [];
    let fehlInFolge = 0;
    // Erst alte Luecken einmal nachpruefen (dann fallen sie weg), dann hochzaehlen.
    const kandidaten: Array<{ n: number; luecke: boolean }> = [];
    for (const l of (p.offeneLuecken ?? []).slice(0, Math.floor(max / 3))) kandidaten.push({ n: l, luecke: true });
    for (let n = p.abNummer; kandidaten.length < max; n++) kandidaten.push({ n, luecke: false });

    for (const k of kandidaten) {
      if (o.abbrechen?.()) break;
      if (basis.abfragen >= max) break;
      if (!k.luecke && fehlInFolge >= maxFehl) break;
      await o.takt.warten();
      const r = await o.portal.suche(p.gericht, p.art, k.n);
      basis.abfragen++;
      if (r.gesperrt) {
        log(`front ${p.gericht} ${p.art}: Portal gesperrt bei ${k.n}`);
        return { ...basis, gesperrt: true, treffer: basis.treffer };
      }
      // Nur Blaetter dieser Nummer zaehlen (Zusatzvarianten, Altgerichte).
      const passend = r.treffer.filter((t) => t.kopfGeparst && t.nummer === k.n);
      if (passend.length > 0) {
        basis.treffer.push(...passend.map((t) => trefferZuMeldung(t, p.gericht)));
        if (!k.luecke) {
          hoechsteMitTreffer = k.n;
          fehlInFolge = 0;
          // Zwischenzeitliche Fehltreffer unterhalb sind Luecken (verzoegert sichtbar).
        }
      } else if (!k.luecke) {
        fehlInFolge++;
        luecken.push(k.n);
      }
    }
    const offeneLuecken = luecken.filter((n) => n < hoechsteMitTreffer).slice(-200);
    log(`front ${p.gericht} ${p.art}: ${basis.abfragen} Abfragen, ${basis.treffer.length} Treffer, Front ${hoechsteMitTreffer}, Luecken ${offeneLuecken.length}`);
    return { ...basis, front: { maxNummer: Math.max(hoechsteMitTreffer, p.abNummer - 1), offeneLuecken, zusaetze: p.zusaetze } };
  }

  if (job.art === "bekanntmachungen") {
    const p = job.payload as unknown as BekPayload;
    await o.takt.warten();
    const r = await o.portal.bekanntmachungenText();
    basis.abfragen = 1;
    if (r.gesperrt) return { ...basis, gesperrt: true };
    const alle = parseBekanntmachungen(r.text);
    const desTages = alle.filter((b) => b.tagIso === p.tag);
    log(`bekanntmachungen ${p.tag}: ${desTages.length} von ${alle.length} Eintraegen`);
    return {
      ...basis,
      bekanntmachungen: desTages.map(({ tagIso: _t, kopf: _k, geparst: _g, ...rest }) => rest),
    };
  }

  // refresh
  const p = job.payload as unknown as RefreshPayload;
  for (const f of p.firmen.slice(0, max)) {
    if (o.abbrechen?.()) break;
    await o.takt.warten();
    const r = await o.portal.suche(f.gericht, f.art, f.nummer);
    basis.abfragen++;
    if (r.gesperrt) return { ...basis, gesperrt: true };
    for (const t of r.treffer) {
      if (!t.kopfGeparst || t.nummer !== f.nummer) continue;
      if (f.zusatz && t.zusatz !== f.zusatz.toUpperCase()) continue;
      const m = trefferZuMeldung(t, f.gericht);
      if (f.hinweis === "loeschung_angekuendigt" && m.status === "ACTIVE") m.status = "LOESCHUNG_ANGEKUENDIGT";
      basis.treffer.push(m);
    }
  }
  log(`refresh (${p.grund ?? "?"}): ${basis.abfragen} Abfragen, ${basis.treffer.length} Treffer`);
  return basis;
}
