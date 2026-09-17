// Ausfuehrung eines geleasten Jobs gegen das Portal. Rein auf den
// Schnittstellen (Portal, Taktgeber) definiert, damit sie sich mit Attrappen
// testen laesst (jobs.test.ts).

import type { Ergebnis, InsolvenzMeldung, Job, TrefferMeldung } from "./gateway-client";
import { bereinigeText, kategorieAusText, type InsolvenzZeile } from "./insolvenz-parser";
import { parseBekanntmachungen, type Treffer } from "./parser";
import { parseStrukturierterInhalt, siBauplan } from "./si-parser";
import type { Suchergebnis } from "./portal";
import { AT_SUCHE_SEITE, companyIdAt, trefferAt, type AtSuchseite, type AtDetail, type TrefferAt } from "./at-firmenbuch";
import { meldungenAusVerfahren, type EdikteEintrag, type EdikteVerfahren } from "./at-edikte";
import { companyIdUk, firmaZuTreffer, meldungenAusFaellen, meldungenAusGazette, type BulkTeil, type FirmaUk, type GazetteEintrag, type InsolvenzFallUk, type TrefferUk } from "./uk-companies-house";

export type PortalSchnittstelle = {
  suche(gericht: string, art: string, nummer: number | string): Promise<Suchergebnis>;
  bekanntmachungenText(): Promise<{ gesperrt: boolean; text: string }>;
  /** SI-XML der Trefferzeile der letzten Suche; null = kein SI-Link (portal.ts). */
  strukturierterInhalt?(zeile: number): Promise<string | null>;
};

export type InsolvenzSchnittstelle = {
  sucheRegistereintrag(gerichtBestand: string, art: string, nummer: number | string): Promise<{ gesperrt: boolean; fehler: string; zeilen: InsolvenzZeile[] }>;
  ladeText(index: number): Promise<string>;
};

export type TaktSchnittstelle = { warten(): Promise<void>; frei(): number };

/** Oesterreich: JustizOnline-JSON und Ediktsdatei, jeweils mit eigenem Takt. */
export type AtSchnittstelle = {
  firmenbuch: { suche(term: string, page: number, gerichtId?: string, state?: string): Promise<AtSuchseite>; detail(fnr: string): Promise<{ detail: AtDetail | null; gesperrt: boolean }> };
  edikte: { fnSuche(fnr: string): Promise<{ eintraege: EdikteEintrag[]; gesperrt: boolean }>; verfahren(docId: string): Promise<{ verfahren: EdikteVerfahren | null; gesperrt: boolean }> };
  taktFirmenbuch: TaktSchnittstelle;
  taktEdikte: TaktSchnittstelle;
};

/** UK: Companies House (Bulk, Firmenseite, Insolvenz) und Gazette, ein Takt fuer alle Web-Aufrufe. */
export type UkSchnittstelle = {
  companiesHouse: {
    bulkTeile(): Promise<BulkTeil[]>;
    bulkTeilLesen(url: string, zeile: (t: TrefferUk) => Promise<void> | void): Promise<number>;
    firma(nummer: string): Promise<{ firma: FirmaUk | null; gesperrt: boolean }>;
    insolvenz(nummer: string): Promise<{ faelle: InsolvenzFallUk[]; gesperrt: boolean }>;
    gazette(nummer: string): Promise<{ eintraege: GazetteEintrag[]; gesperrt: boolean }>;
  };
  takt: TaktSchnittstelle;
  /** uk_bulk: Buendel an das Gateway melden (Worker: gateway.teilergebnis). */
  teilergebnis: (jobId: string, teil: number, trefferUk: TrefferUk[]) => Promise<void>;
};

export type AusfuehrungsOptionen = {
  workerId: string;
  portal: PortalSchnittstelle;
  /** Insolvenzportal (lazy; nur fuer Jobs der Art insolvenz). */
  insolvenz?: () => Promise<InsolvenzSchnittstelle>;
  takt: TaktSchnittstelle;
  /** Oesterreich (nur fuer Jobs at_*). */
  at?: AtSchnittstelle;
  /** UK (nur fuer Jobs uk_*). */
  uk?: UkSchnittstelle;
  /** Hoechstzahl Abfragen je Job; muss in die Lease (20 min) passen. */
  maxAbfragenJeJob?: number;
  /** Oesterreich: Anfragen je Job bei 0,5/s (Default 300 ≈ 10 min). */
  maxAbfragenJeAtJob?: number;
  log?: (zeile: string) => void;
  /** Abbruchsignal (Desktop: Nutzer pausiert, Akku, Chat aktiv). */
  abbrechen?: () => boolean;
  /**
   * refresh: strukturierten Registerinhalt je Firma mitladen (S8). Kostet eine
   * zweite Portalabfrage je Firma; Fehler oder fehlender SI-Link lassen den
   * Registertreffer unberuehrt und brechen den Job nicht ab.
   */
  si?: boolean;
};

export const MAX_ABFRAGEN_JE_JOB = 15;
export const MAX_ABFRAGEN_JE_AT_JOB = 300;
/**
 * uk_bulk: Zeilen je Teilergebnis (ein Delta-Aufruf in master-data) und Pause danach.
 * Entscheidung 2026-09-16: master-data (ein geteilter CPU-Kern) wurde vom Erstimport
 * mit 11 Buendeln je Minute dauerhaft gedrosselt (79 % CPU-Steal), alle Nutzeranfragen
 * standen dahinter an. Standard jetzt schonend: 250 Zeilen, dann 20 s Pause; per Umgebung
 * (REGISTER_DELTA_UK_BUENDEL, REGISTER_DELTA_UK_PAUSE_MS) anpassbar.
 */
export const UK_BULK_BUENDEL = Math.max(50, Math.min(1000, Number(process.env.REGISTER_DELTA_UK_BUENDEL ?? 250) || 250));
export const UK_BULK_PAUSE_MS = Math.max(0, Number(process.env.REGISTER_DELTA_UK_PAUSE_MS ?? 20_000) || 0);

// Die Bekanntmachungsseite enthaelt alle Tage des 8-Wochen-Fensters (rund
// 14.000 Eintraege, fast 2 MB Text). Ein Job je Tag wuerde sie 56-mal laden;
// stattdessen wird der Seitentext je Prozess 30 Minuten vorgehalten.
const BEK_CACHE_MS = 30 * 60_000;
let bekCache: { text: string; at: number } | null = null;

export function leereBekanntmachungsCache(): void {
  bekCache = null;
}

/**
 * Blaetter einer Nummer → Meldungen. Regel wie der Bestand: hat die Nummer nur
 * ein Blatt (auch eines eines frueheren Gerichts), traegt es die reine Id;
 * gibt es zur Nummer ein aktuelles Blatt UND Blaetter frueherer Gerichte,
 * behalten nur die frueheren den Anhang _F<ALTGERICHT>. Das Gericht kommt
 * aus dem Job (Schreibweise des Bestands), nicht aus der Kopfzeile.
 */
export function meldungenJeNummer(treffer: Treffer[], gericht: string): TrefferMeldung[] {
  const gruppen = new Map<string, Treffer[]>();
  for (const t of treffer) {
    const k = `${t.art}|${t.nummer}|${t.zusatz}`;
    gruppen.set(k, [...(gruppen.get(k) ?? []), t]);
  }
  const out: TrefferMeldung[] = [];
  for (const g of gruppen.values()) {
    const mehrere = g.length > 1;
    for (const t of g) out.push({ ...trefferZuMeldung(t, gericht), gericht, frueherSuffix: mehrere && Boolean(t.frueher) });
  }
  return out;
}

export function trefferZuMeldung(t: Treffer, gerichtFallback?: string): TrefferMeldung {
  return {
    gericht: gerichtFallback || t.gericht || "",
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
type InsolvenzPayload = { firmen: Array<{ companyId: string; gericht: string; art: string; nummer: string; zusatz?: string }>; grund?: string };
type AtFrontPayload = { gerichtId: string; begriff: string; abSeite?: number; state?: string };
type AtFirmenPayload = { firmen: Array<{ companyId: string; fnr: string }>; grund?: string };
type UkBulkPayload = { url: string; datum: string; teil: number; teile: number };
type UkFirmenPayload = { firmen: Array<{ companyId: string; nummer: string }>; grund?: string };

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
        basis.treffer.push(...meldungenJeNummer(passend, p.gericht));
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
    let text: string;
    if (bekCache && Date.now() - bekCache.at < BEK_CACHE_MS) {
      text = bekCache.text;
      basis.abfragen = 0;
    } else {
      await o.takt.warten();
      const r = await o.portal.bekanntmachungenText();
      basis.abfragen = 1;
      if (r.gesperrt) return { ...basis, gesperrt: true };
      text = r.text;
      bekCache = { text, at: Date.now() };
    }
    const alle = parseBekanntmachungen(text);
    const desTages = alle.filter((b) => b.tagIso === p.tag);
    log(`bekanntmachungen ${p.tag}: ${desTages.length} von ${alle.length} Eintraegen`);
    return {
      ...basis,
      bekanntmachungen: desTages.map(({ tagIso: _t, kopf: _k, geparst: _g, ...rest }) => rest),
    };
  }

  if (job.art === "insolvenz") {
    if (!o.insolvenz) throw new Error("Insolvenzportal nicht verfuegbar");
    const p = job.payload as unknown as InsolvenzPayload;
    const portal = await o.insolvenz();
    const meldungen: InsolvenzMeldung[] = [];
    const geprueft: string[] = [];
    for (const f of p.firmen) {
      if (o.abbrechen?.()) break;
      if (basis.abfragen >= max) break; // Rest bleibt faellig und kommt mit dem naechsten Cron
      await o.takt.warten();
      const r = await portal.sucheRegistereintrag(f.gericht, f.art, f.nummer);
      basis.abfragen++;
      if (r.gesperrt) return { ...basis, gesperrt: true, insolvenz: { meldungen, geprueft } };
      // Nur Zeilen, deren Registereintrag exakt unsere Firma ist (Zusatzvarianten ausschliessen).
      const passend = r.zeilen.filter((z) => z.registereintrag && z.registereintrag.companyId === f.companyId);
      for (const z of passend) {
        if (basis.abfragen >= max + 10) break; // Texte zaehlen mit, kleiner Puffer je Job
        await o.takt.warten();
        const html = await portal.ladeText(z.index);
        basis.abfragen++;
        const text = bereinigeText(html);
        meldungen.push({ companyId: f.companyId, aktenzeichen: z.aktenzeichen, insolvenzgericht: z.insolvenzgericht, datum: z.datumIso, gegenstand: kategorieAusText(text || z.name), text });
      }
      geprueft.push(f.companyId);
    }
    log(`insolvenz (${p.grund ?? "?"}): ${geprueft.length} Firmen geprueft, ${meldungen.length} Veroeffentlichungen, ${basis.abfragen} Abfragen`);
    return { ...basis, insolvenz: { meldungen, geprueft } };
  }

  if (job.art === "uk_bulk" || job.art === "uk_refresh" || job.art === "uk_insolvenz") {
    if (!o.uk) throw new Error("UK-Schnittstellen nicht verfuegbar");
    return fuehreUkJobAus(job, o, o.uk, o.maxAbfragenJeAtJob ?? MAX_ABFRAGEN_JE_AT_JOB, log);
  }

  if (job.art === "at_front" || job.art === "at_refresh" || job.art === "at_insolvenz") {
    if (!o.at) throw new Error("Oesterreich-Schnittstellen nicht verfuegbar");
    return fuehreAtJobAus(job, o, o.at, o.maxAbfragenJeAtJob ?? MAX_ABFRAGEN_JE_AT_JOB, log);
  }

  // refresh
  const p = job.payload as unknown as RefreshPayload;
  const siAktiv = o.si === true && typeof o.portal.strukturierterInhalt === "function";
  const si = { geladen: 0, ohneLink: 0, fehler: 0 };
  const unbearbeitet: RefreshPayload["firmen"] = [];
  const kostenJeFirma = siAktiv ? 2 : 1;
  for (const f of p.firmen) {
    if (o.abbrechen?.() || basis.abfragen + kostenJeFirma > max) {
      unbearbeitet.push(f);
      continue;
    }
    await o.takt.warten();
    const r = await o.portal.suche(f.gericht, f.art, f.nummer);
    basis.abfragen++;
    if (r.gesperrt) return { ...basis, gesperrt: true, unbearbeitet: [f, ...unbearbeitet] };
    const passend = r.treffer.filter((t) => t.kopfGeparst && t.nummer === f.nummer && (!f.zusatz || t.zusatz === f.zusatz.toUpperCase()));
    const meldungen = meldungenJeNummer(passend, f.gericht);
    for (const m of meldungen) {
      if (f.hinweis === "loeschung_angekuendigt" && m.status === "ACTIVE") m.status = "LOESCHUNG_ANGEKUENDIGT";
      basis.treffer.push(m);
    }
    if (!siAktiv || passend.length === 0) continue;
    // SI nur fuer das aktuelle Blatt (nicht die Altgerichts-Variante) und nur,
    // wenn es eine Meldung dazu gibt. Jeder Fehler bleibt bei dieser Firma.
    const ziel = passend.find((t) => !t.frueher) ?? passend[0];
    const meldung = meldungen.find((m) => m.zusatz === ziel.zusatz && m.frueher === ziel.frueher);
    if (!meldung) continue;
    try {
      await o.takt.warten();
      const xml = await o.portal.strukturierterInhalt!(r.treffer.indexOf(ziel)); // eslint-disable-line @typescript-eslint/no-non-null-assertion
      if (xml === null) {
        si.ohneLink++;
        continue;
      }
      basis.abfragen++;
      const inhalt = parseStrukturierterInhalt(xml);
      if (!inhalt) {
        si.fehler++;
        log(`refresh ${f.gericht} ${f.art} ${f.nummer}: SI-XML nicht lesbar (${xml.length} Zeichen, Aufbau: ${siBauplan(xml)})`);
        continue;
      }
      meldung.si = inhalt;
      si.geladen++;
    } catch (err) {
      const grund = err instanceof Error ? err.message : String(err);
      if (/gesperrt/i.test(grund)) return { ...basis, gesperrt: true, si, unbearbeitet };
      si.fehler++;
      log(`refresh ${f.gericht} ${f.art} ${f.nummer}: SI fehlgeschlagen: ${grund}`);
    }
  }
  log(`refresh (${p.grund ?? "?"}): ${basis.abfragen} Abfragen, ${basis.treffer.length} Treffer${siAktiv ? `, SI ${si.geladen} geladen / ${si.ohneLink} ohne Link / ${si.fehler} Fehler` : ""}${unbearbeitet.length ? `, ${unbearbeitet.length} unbearbeitet` : ""}`);
  return { ...basis, ...(siAktiv ? { si } : {}), ...(unbearbeitet.length ? { unbearbeitet } : {}) };
}

async function fuehreAtJobAus(job: Job, o: AusfuehrungsOptionen, at: AtSchnittstelle, max: number, log: (z: string) => void): Promise<Ergebnis> {
  const basis: Ergebnis = { workerId: o.workerId, abfragen: 0, treffer: [] };

  if (job.art === "at_front") {
    // Aufzaehlung je (Gericht, Begriff): Seiten zu 10, bis numResults erreicht
    // oder das Job-Budget aufgebraucht ist (dann Fortsetzung ueber atFront).
    const p = job.payload as unknown as AtFrontPayload;
    const trefferAt_: TrefferAt[] = [];
    let seite = p.abSeite ?? 0;
    let gesamt = 0;
    let fertig = false;
    while (basis.abfragen < max) {
      if (o.abbrechen?.()) break;
      await at.taktFirmenbuch.warten();
      const r = await at.firmenbuch.suche(p.begriff, seite, p.gerichtId, p.state ?? "ACTIVE");
      basis.abfragen++;
      if (r.gesperrt) return { ...basis, gesperrt: true, trefferAt: trefferAt_, atFront: { begriff: p.begriff, naechsteSeite: seite, fertig: false, gesamt } };
      gesamt = r.gesamt;
      for (const t of r.treffer) trefferAt_.push(trefferAt(t, p.gerichtId));
      seite++;
      if (r.treffer.length < AT_SUCHE_SEITE || seite * AT_SUCHE_SEITE >= gesamt) {
        fertig = true;
        break;
      }
    }
    log(`at_front ${p.gerichtId} "${p.begriff}": ${basis.abfragen} Seiten, ${trefferAt_.length} von ${gesamt} Firmen${fertig ? "" : ", Fortsetzung ab Seite " + seite}`);
    return { ...basis, trefferAt: trefferAt_, atFront: { begriff: p.begriff, naechsteSeite: seite, fertig, gesamt } };
  }

  if (job.art === "at_refresh") {
    // Detail je FN: Rechtsform, Adresse, Status (2 Anfragen je Firma: Suche nach Versions-Id, Detail).
    const p = job.payload as unknown as AtFirmenPayload;
    const trefferAt_: TrefferAt[] = [];
    for (const f of p.firmen) {
      if (o.abbrechen?.() || basis.abfragen + 2 > max) break;
      await at.taktFirmenbuch.warten();
      const r = await at.firmenbuch.detail(f.fnr);
      basis.abfragen += 2;
      if (r.gesperrt) return { ...basis, gesperrt: true, trefferAt: trefferAt_ };
      if (!r.detail) continue; // unbekannt: Bestand bleibt, kein Loeschen
      const gerichtId = gerichtIdAus(job.payload, f.companyId);
      trefferAt_.push(trefferAt(r.detail, gerichtId));
    }
    log(`at_refresh (${p.grund ?? "?"}): ${basis.abfragen} Abfragen, ${trefferAt_.length} Treffer`);
    return { ...basis, trefferAt: trefferAt_ };
  }

  // at_insolvenz: Ediktsdatei je FN, alle Bekanntmachungen jedes Verfahrens (idempotent im Gateway).
  const p = job.payload as unknown as AtFirmenPayload;
  const meldungen: InsolvenzMeldung[] = [];
  const geprueft: string[] = [];
  for (const f of p.firmen) {
    if (o.abbrechen?.() || basis.abfragen >= max) break;
    await at.taktEdikte.warten();
    const r = await at.edikte.fnSuche(f.fnr);
    basis.abfragen++;
    if (r.gesperrt) return { ...basis, gesperrt: true, insolvenz: { meldungen, geprueft } };
    for (const e of r.eintraege) {
      await at.taktEdikte.warten();
      const v = await at.edikte.verfahren(e.docId);
      basis.abfragen++;
      if (v.gesperrt) return { ...basis, gesperrt: true, insolvenz: { meldungen, geprueft } };
      // Nur Verfahren, deren FN exakt unsere Firma ist.
      if (!v.verfahren?.fn) continue;
      let cid: string;
      try {
        cid = companyIdAt(v.verfahren.fn);
      } catch {
        continue;
      }
      if (cid !== f.companyId) continue;
      meldungen.push(...meldungenAusVerfahren(v.verfahren, f.companyId));
    }
    geprueft.push(f.companyId);
  }
  log(`at_insolvenz (${p.grund ?? "?"}): ${geprueft.length} Firmen geprueft, ${meldungen.length} Bekanntmachungen, ${basis.abfragen} Abfragen`);
  return { ...basis, insolvenz: { meldungen, geprueft } };
}

/** Gericht fuer den Refresh: aus dem Payload (je Firma oder je Job), sonst leer (Gateway behaelt den Bestand). */
function gerichtIdAus(payload: Record<string, unknown>, companyId: string): string {
  const firmen = payload.firmen as Array<{ companyId: string; gerichtId?: string }> | undefined;
  return firmen?.find((f) => f.companyId === companyId)?.gerichtId ?? (typeof payload.gerichtId === "string" ? payload.gerichtId : "");
}

async function fuehreUkJobAus(job: Job, o: AusfuehrungsOptionen, uk: UkSchnittstelle, max: number, log: (z: string) => void): Promise<Ergebnis> {
  const basis: Ergebnis = { workerId: o.workerId, abfragen: 0, treffer: [] };

  if (job.art === "uk_bulk") {
    // Ein Teil des Monatsabzugs: ZIP laden, CSV streamen, in Buendeln an das
    // Gateway melden (Teilergebnisse verlaengern die Lease). Abbruch ist
    // erlaubt: das Gateway kennt die gemeldeten Buendel, der Job faellt zurueck.
    const p = job.payload as unknown as UkBulkPayload;
    let buendel: TrefferUk[] = [];
    let teil = 0;
    let abgebrochen = false;
    let tLetzte = Date.now();
    const melden = async () => {
      if (buendel.length === 0) return;
      teil++;
      const tLesen = Date.now() - tLetzte;
      const t0 = Date.now();
      await uk.teilergebnis(job.id, teil, buendel);
      if (teil % 10 === 0) log(`uk_bulk Teil ${p.teil} Buendel ${teil}: lesen ${tLesen} ms, melden ${Date.now() - t0} ms`);
      tLetzte = Date.now();
      buendel = [];
      // Schonender Takt: master-data zwischen zwei Buendeln Luft lassen.
      if (UK_BULK_PAUSE_MS > 0) await new Promise((r) => setTimeout(r, UK_BULK_PAUSE_MS));
    };
    await uk.takt.warten();
    basis.abfragen++;
    const zeilen = await uk.companiesHouse.bulkTeilLesen(p.url, async (t) => {
      if (abgebrochen) return;
      if (o.abbrechen?.()) {
        abgebrochen = true;
        return;
      }
      buendel.push(t);
      if (buendel.length >= UK_BULK_BUENDEL) await melden();
    });
    if (abgebrochen) throw new Error(`uk_bulk Teil ${p.teil} abgebrochen nach ${teil} Buendeln`);
    await melden();
    log(`uk_bulk ${p.datum} Teil ${p.teil}/${p.teile}: ${zeilen} Zeilen in ${teil} Buendeln`);
    return { ...basis, ukBulk: { datum: p.datum, teil: p.teil, teile: p.teile, zeilen, teilergebnisse: teil } };
  }

  if (job.art === "uk_refresh") {
    const p = job.payload as unknown as UkFirmenPayload;
    const trefferUk: TrefferUk[] = [];
    for (const f of p.firmen) {
      if (o.abbrechen?.() || basis.abfragen >= max) break;
      await uk.takt.warten();
      const r = await uk.companiesHouse.firma(f.nummer);
      basis.abfragen++;
      if (r.gesperrt) return { ...basis, gesperrt: true, trefferUk };
      if (!r.firma) continue; // unbekannt: Bestand bleibt
      const t = firmaZuTreffer(r.firma);
      if (t) trefferUk.push(t);
    }
    log(`uk_refresh (${p.grund ?? "?"}): ${basis.abfragen} Abfragen, ${trefferUk.length} Treffer`);
    return { ...basis, trefferUk };
  }

  // uk_insolvenz: Insolvenzseite plus Gazette je Firma.
  const p = job.payload as unknown as UkFirmenPayload;
  const meldungen: InsolvenzMeldung[] = [];
  const geprueft: string[] = [];
  for (const f of p.firmen) {
    if (o.abbrechen?.() || basis.abfragen + 2 > max) break;
    let cid: string;
    try {
      cid = companyIdUk(f.nummer);
    } catch {
      continue;
    }
    if (cid !== f.companyId) continue;
    await uk.takt.warten();
    const i = await uk.companiesHouse.insolvenz(f.nummer);
    basis.abfragen++;
    if (i.gesperrt) return { ...basis, gesperrt: true, insolvenz: { meldungen, geprueft } };
    meldungen.push(...meldungenAusFaellen(i.faelle, f.companyId));
    await uk.takt.warten();
    const g = await uk.companiesHouse.gazette(f.nummer);
    basis.abfragen++;
    if (g.gesperrt) return { ...basis, gesperrt: true, insolvenz: { meldungen, geprueft } };
    meldungen.push(...meldungenAusGazette(g.eintraege, f.companyId));
    geprueft.push(f.companyId);
  }
  log(`uk_insolvenz (${p.grund ?? "?"}): ${geprueft.length} Firmen geprueft, ${meldungen.length} Meldungen, ${basis.abfragen} Abfragen`);
  return { ...basis, insolvenz: { meldungen, geprueft } };
}
