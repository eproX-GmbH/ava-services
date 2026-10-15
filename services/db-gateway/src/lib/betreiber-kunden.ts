// Betreiber-Sicht je Kunde (Abrechnungskonto): Bestand je Stufe und Monat, gemessene
// Spurkosten (Betreiber-Modell, Google-Suchen, Apify), Firmenerloes zu heutigen
// Stufenpreisen, Enterprise-Preisempfehlung mit Begruendung und CSV-Export.
// Nur ueber die Betreiber-Routen erreichbar (istBetreiber).

import type { Pool } from "pg";
import { stufenPreise } from "./stufen";
import { tarif } from "./kalkulation";
import { openaiFaktorJeMonat, valueserpTarif } from "./anbieter-kosten";

type Stufe = "klein" | "mittel" | "gross";
const STUFEN: Stufe[] = ["klein", "mittel", "gross"];
/** Apify-Lauf ohne nachgetragene Kosten (noch laufend/unbekannt): Mittel aus der Kalkulation. */
const APIFY_USD_JE_LAUF = 0.12;
const USD_EUR = 0.92;

export interface KundeZeile {
  tenantId: string;
  name: string;
  kind: "organisation" | "personal";
  tier: string;
  mode: string;
  status: string;
  mitglieder: number;
  bestandAktuell: number;
  ausgabenLimitCents: number | null;
  betreiberLimitCents: number | null;
  /** Enterprise-Vertrag: ausgehandelter Fixpreis je Monat (Cent), null = keiner. */
  enterprisePreisCents: number | null;
  /** Organisation ohne Mitglieder, als geloescht markiert (Daten bleiben). */
  geloescht: boolean;
}

export async function kundenListe(pool: Pool): Promise<KundeZeile[]> {
  const periode = aktuellePeriode();
  const r = await pool.query<{
    tenantId: string; name: string | null; kind: string | null; tier: string; mode: string; status: string;
    mitglieder: string; bestand: string; ausgabenLimitCents: number | null; betreiberLimitCents: number | null; enterprisePreisCents: number | null; deletedAt: Date | null;
  }>(
    // Kunden sind Organisationen (Registrierung verlangt seit 2026-10-15 eine
    // Organisation); persoenliche Tenants sind technische Altlast und bleiben aussen vor.
    `SELECT t.id AS "tenantId", t.name, t.kind, t."deletedAt", COALESCE(b.tier, 'free') AS tier, COALESCE(b.mode, 'none') AS mode, COALESCE(b.status, 'active') AS status,
            b."ausgabenLimitCents", b."betreiberLimitCents", b."enterprisePreisCents",
            (SELECT COUNT(*) FROM "TenantMember" m WHERE m."tenantId" = t.id)::text AS mitglieder,
            (SELECT COUNT(*) FROM "UsageEntry" u WHERE u."billingAccountId" = t.id AND u."periodKey" IN ($1, 'lifetime'))::text AS bestand
       FROM "Tenant" t LEFT JOIN "TenantBilling" b ON b."tenantId" = t.id
      WHERE t.kind = 'organisation'
      ORDER BY (t."deletedAt" IS NULL) DESC, t.name NULLS LAST, t.id`,
    [periode],
  );
  return r.rows.map((x) => ({
    tenantId: x.tenantId,
    name: x.name ?? x.tenantId,
    kind: x.kind === "organisation" ? "organisation" : "personal",
    tier: x.tier,
    mode: x.mode,
    status: x.status,
    mitglieder: Number(x.mitglieder),
    bestandAktuell: Number(x.bestand),
    ausgabenLimitCents: x.ausgabenLimitCents,
    betreiberLimitCents: x.betreiberLimitCents,
    enterprisePreisCents: x.enterprisePreisCents,
    geloescht: x.deletedAt != null,
  }));
}

export interface MonatZeile {
  monat: string;
  aufnahmen: Record<Stufe | "offen", number>;
  bestand: number;
  /** Bestandswert zu heutigen Stufenpreisen (Cent), unabhaengig vom Plan. */
  bestandswertCents: number;
  /** Firmenerloes (Cent): nur zahlende Plaene (starter/pro), sonst 0. */
  firmenerloesCents: number;
  /** Seat-Erloes (Cent): zahlende Plaene Mitglieder x Seatpreis, sonst 0. */
  seatErloesCents: number;
  /** Enterprise: vereinbarter Fixpreis (Cent), sonst 0. */
  fixpreisCents: number;
  /** Rechnungsbetrag des Monats (Cent): Firmen + Seats bzw. Fixpreis. */
  erloesCents: number;
  direktkostenCents: number;
  modellAufrufe: number;
  /** Gerechnet aus Tokens und Preistabelle. */
  modellUsd: number;
  /** Laut OpenAI-Rechnung umgelegt (Faktor echt/gerechnet des Monats), null ohne Abgleich. */
  modellUsdEcht: number | null;
  apifyLaeufe: number;
  /** Echte Laufkosten laut Apify; Laeufe ohne nachgetragene Kosten mit Mittelwert. */
  apifyUsd: number;
  apifyLaeufeOhneKosten: number;
  serpSuchen: number;
  serpUsd: number;
  /** Abfragen je Abrechnungstarif. */
  serpTarife: Array<{ tarif: string; suchen: number; usd: number }>;
  /** Spurkosten gesamt in Cent (EUR, Umrechnung USD_EUR). */
  spurkostenCents: number;
}

export interface KundeDetail {
  kunde: KundeZeile;
  monate: MonatZeile[];
  bestandHeute: Record<Stufe | "offen", number>;
  preise: Record<Stufe, { preisCents: number; direktkostenCents: number }>;
  empfehlung: Empfehlung;
}

export interface Empfehlung {
  instanzen: number;
  seats: number;
  bestandHeute: number;
  zuwachsSpitzeJeMonat: number;
  zuwachsMittelJeMonat: number;
  bestandIn12Monaten: number;
  mittlererStufenpreisCents: number;
  posten: Array<{ bezeichnung: string; heuteCents: number; in12MonatenCents: number; hinweis: string }>;
  listenpreisHeuteCents: number;
  listenpreisIn12MonatenCents: number;
  direktkostenHeuteCents: number;
  direktkostenIn12MonatenCents: number;
  spurkostenMittelCents: number;
  empfehlungCents: number;
  mindestpreisCents: number;
  limitVorschlagCents: number;
  margeBeiEmpfehlungProzent: number;
  gruende: string[];
}

function aktuellePeriode(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function periodenListe(monate: number): string[] {
  const out: string[] = [];
  const d = new Date();
  for (let i = 0; i < monate; i++) {
    const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1));
    out.push(`${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

function leer(): Record<Stufe | "offen", number> {
  return { klein: 0, mittel: 0, gross: 0, offen: 0 };
}

export async function kundeDetail(pool: Pool, tenantId: string, monate: number, instanzen: number): Promise<KundeDetail | null> {
  const liste = await kundenListe(pool);
  let kunde = liste.find((k) => k.tenantId === tenantId) ?? null;
  if (!kunde) {
    // Konto ohne Treffer in der Liste (z. B. Free ohne Aufnahmen): trotzdem anzeigen.
    const r = await pool.query<{ tenantId: string; name: string | null; kind: string | null; tier: string; mode: string; status: string; ausgabenLimitCents: number | null; betreiberLimitCents: number | null; enterprisePreisCents: number | null }>(
      `SELECT b."tenantId", t.name, t.kind, b.tier, b.mode, b.status, b."ausgabenLimitCents", b."betreiberLimitCents", b."enterprisePreisCents" FROM "TenantBilling" b LEFT JOIN "Tenant" t ON t.id = b."tenantId" WHERE b."tenantId" = $1`,
      [tenantId],
    );
    const x = r.rows[0];
    if (!x) return null;
    kunde = { tenantId: x.tenantId, name: x.name ?? x.tenantId, kind: x.kind === "organisation" ? "organisation" : "personal", tier: x.tier, mode: x.mode, status: x.status, mitglieder: 1, bestandAktuell: 0, ausgabenLimitCents: x.ausgabenLimitCents, betreiberLimitCents: x.betreiberLimitCents, enterprisePreisCents: x.enterprisePreisCents, geloescht: false };
  }
  const preise = stufenPreise();
  const zahlend = kunde.tier === "starter" || kunde.tier === "pro";
  const seatPreis = Math.round((tarif().find((t) => t.posten === "seat")?.preisEur ?? 49) * 100);
  const instanzTarif = tarif().find((t) => t.posten === "instanz");
  const instanzPreis = Math.round((instanzTarif?.preisEur ?? 59) * 100);
  const instanzKosten = Math.round((instanzTarif?.kostenEur ?? 34) * 100);
  const perioden = periodenListe(monate);

  const [aufn, modell, apify, serp] = await Promise.all([
    pool.query<{ periodKey: string; stufe: string | null; n: string }>(
      `SELECT "periodKey", "stufe", COUNT(*)::text AS n FROM "UsageEntry" WHERE "billingAccountId" = $1 AND ("periodKey" = ANY($2::text[]) OR "periodKey" = 'lifetime') GROUP BY 1, 2`,
      [tenantId, perioden],
    ),
    pool.query<{ monat: string; n: string; usd: string }>(
      `SELECT to_char(date_trunc('month', "createdAt"), 'YYYY-MM') AS monat, COUNT(*)::text AS n, COALESCE(SUM("costMicroUsd"), 0)::text AS usd
         FROM "LlmUsage" WHERE kind = 'betreiber' AND "tenantId" = $1 AND "createdAt" > NOW() - ($2 || ' months')::interval GROUP BY 1`,
      [tenantId, String(monate)],
    ),
    pool.query<{ monat: string; n: string; ohne: string; usd: string }>(
      `SELECT to_char(date_trunc('month', "createdAt"), 'YYYY-MM') AS monat, COUNT(*)::text AS n, COUNT(*) FILTER (WHERE "costMicroUsd" IS NULL)::text AS ohne, COALESCE(SUM("costMicroUsd"), 0)::text AS usd
         FROM "LlmUsage" WHERE kind = 'apify' AND "tenantId" = $1 AND "createdAt" > NOW() - ($2 || ' months')::interval GROUP BY 1`,
      [tenantId, String(monate)],
    ),
    pool.query<{ monat: string; tarif: string | null; n: string; usd: string }>(
      `SELECT to_char(date_trunc('month', "createdAt"), 'YYYY-MM') AS monat, tarif, COUNT(*) FILTER (WHERE NOT "cacheHit" AND status < 400)::text AS n, COALESCE(SUM("kostenMicroUsd"), 0)::text AS usd
         FROM "ProxyAudit" WHERE proxy = 'valueserp' AND "tenantId" = $1 AND "createdAt" > NOW() - ($2 || ' months')::interval GROUP BY 1, 2`,
      [tenantId, String(monate)],
    ),
  ]);
  const faktor = await openaiFaktorJeMonat(pool, monate).catch(() => new Map<string, number>());
  const serpTarif = valueserpTarif();

  const jeMonat = new Map<string, MonatZeile>();
  const zeile = (m: string): MonatZeile => {
    let z = jeMonat.get(m);
    if (!z) {
      z = { monat: m, aufnahmen: leer(), bestand: 0, bestandswertCents: 0, firmenerloesCents: 0, seatErloesCents: zahlend ? kunde!.mitglieder * seatPreis : 0, fixpreisCents: kunde!.tier === "enterprise" ? (kunde!.enterprisePreisCents ?? 0) : 0, erloesCents: 0, direktkostenCents: 0, modellAufrufe: 0, modellUsd: 0, modellUsdEcht: null, apifyLaeufe: 0, apifyUsd: 0, apifyLaeufeOhneKosten: 0, serpSuchen: 0, serpUsd: 0, serpTarife: [], spurkostenCents: 0 };
      jeMonat.set(m, z);
    }
    return z;
  };
  for (const r of aufn.rows) {
    const m = r.periodKey === "lifetime" ? "lifetime" : r.periodKey;
    const z = zeile(m);
    const n = Number(r.n);
    const st = (STUFEN as string[]).includes(r.stufe ?? "") ? (r.stufe as Stufe) : "offen";
    z.aufnahmen[st] += n;
    z.bestand += n;
    if (st !== "offen") {
      z.bestandswertCents += n * preise[st].preisCents;
      z.direktkostenCents += n * preise[st].direktkostenCents;
    } else {
      z.bestandswertCents += n * preise.klein.preisCents;
      z.direktkostenCents += n * preise.klein.direktkostenCents;
    }
  }
  for (const r of modell.rows) {
    const z = zeile(r.monat);
    z.modellAufrufe = Number(r.n);
    z.modellUsd = Number(r.usd) / 1e6;
    const f = faktor.get(r.monat);
    z.modellUsdEcht = f == null ? null : z.modellUsd * f;
  }
  for (const r of apify.rows) {
    const z = zeile(r.monat);
    z.apifyLaeufe = Number(r.n);
    z.apifyLaeufeOhneKosten = Number(r.ohne);
    z.apifyUsd = Number(r.usd) / 1e6 + z.apifyLaeufeOhneKosten * APIFY_USD_JE_LAUF;
  }
  for (const r of serp.rows) {
    const z = zeile(r.monat);
    const n = Number(r.n);
    const usd = r.tarif ? Number(r.usd) / 1e6 : (n * serpTarif.preisMicroUsd) / 1e6;
    z.serpSuchen += n;
    z.serpUsd += usd;
    z.serpTarife.push({ tarif: r.tarif ?? `${serpTarif.name} (angenommen)`, suchen: n, usd: Math.round(usd * 100) / 100 });
  }
  for (const z of jeMonat.values()) {
    z.firmenerloesCents = zahlend ? z.bestandswertCents : 0;
    z.erloesCents = z.firmenerloesCents + z.seatErloesCents + z.fixpreisCents;
    z.spurkostenCents = Math.round(((z.modellUsdEcht ?? z.modellUsd) + z.apifyUsd + z.serpUsd) * USD_EUR * 100);
    z.modellUsd = Math.round(z.modellUsd * 100) / 100;
    z.modellUsdEcht = z.modellUsdEcht == null ? null : Math.round(z.modellUsdEcht * 100) / 100;
    z.apifyUsd = Math.round(z.apifyUsd * 100) / 100;
    z.serpUsd = Math.round(z.serpUsd * 100) / 100;
  }
  const zeilen = [...jeMonat.values()].sort((a, b) => (a.monat === "lifetime" ? 1 : b.monat === "lifetime" ? -1 : b.monat.localeCompare(a.monat)));
  const heute = jeMonat.get(aktuellePeriode());
  const bestandHeute = heute ? { ...heute.aufnahmen } : leer();
  // Free-Konten: lebenslange Zeilen zaehlen als heutiger Bestand.
  const lifetime = jeMonat.get("lifetime");
  if (lifetime) for (const k of Object.keys(bestandHeute) as Array<Stufe | "offen">) bestandHeute[k] += lifetime.aufnahmen[k];

  const empfehlung = empfehlungRechnen({ kunde, zeilen, bestandHeute, preise, seatPreis, instanzen, instanzPreis, instanzKosten });
  return { kunde, monate: zeilen, bestandHeute, preise, empfehlung };
}

function empfehlungRechnen(a: {
  kunde: KundeZeile; zeilen: MonatZeile[]; bestandHeute: Record<Stufe | "offen", number>;
  preise: Record<Stufe, { preisCents: number; direktkostenCents: number }>; seatPreis: number; instanzen: number; instanzPreis: number; instanzKosten: number;
}): Empfehlung {
  const { kunde, preise } = a;
  const seats = Math.max(1, kunde.mitglieder);
  const bestand = a.bestandHeute.klein + a.bestandHeute.mittel + a.bestandHeute.gross + a.bestandHeute.offen;
  // Stufenmix heute (offene zaehlen wie klein); ohne Bestand: Annahme mittel.
  const gewichtet = bestand > 0
    ? ((a.bestandHeute.klein + a.bestandHeute.offen) * preise.klein.preisCents + a.bestandHeute.mittel * preise.mittel.preisCents + a.bestandHeute.gross * preise.gross.preisCents) / bestand
    : preise.mittel.preisCents;
  const gewichteteKosten = bestand > 0
    ? ((a.bestandHeute.klein + a.bestandHeute.offen) * preise.klein.direktkostenCents + a.bestandHeute.mittel * preise.mittel.direktkostenCents + a.bestandHeute.gross * preise.gross.direktkostenCents) / bestand
    : preise.mittel.direktkostenCents;
  // Zuwachs je Monat aus der Bestandsreihe (aelteste → juengste), nur Monatszeilen.
  const reihe = a.zeilen.filter((z) => z.monat !== "lifetime").slice().reverse();
  const deltas: number[] = [];
  for (let i = 1; i < reihe.length; i++) deltas.push(Math.max(0, reihe[i]!.bestand - reihe[i - 1]!.bestand));
  if (reihe.length === 1) deltas.push(reihe[0]!.bestand);
  const spitze = deltas.length ? Math.max(...deltas) : Math.max(10, Math.round(bestand * 0.2));
  const mittel = deltas.length ? Math.round(deltas.reduce((s, x) => s + x, 0) / deltas.length) : spitze;
  const bestand12 = bestand + spitze * 12;
  const firmenHeute = Math.round(bestand * gewichtet);
  const firmen12 = Math.round(bestand12 * gewichtet);
  const seatsCents = seats * a.seatPreis;
  const instanzCents = a.instanzen * a.instanzPreis;
  const posten = [
    { bezeichnung: `Pro-Seats (${seats} Nutzer)`, heuteCents: seatsCents, in12MonatenCents: seatsCents, hinweis: "Listenpreis je Nutzer und Monat; Chat, Radar und Recherche laufen ueber das Modell des Kunden" },
    { bezeichnung: `Firmen im Bestand (${bestand} heute, ${bestand12} in 12 Monaten)`, heuteCents: firmenHeute, in12MonatenCents: firmen12, hinweis: `mittlerer Stufenpreis ${(gewichtet / 100).toFixed(2)} EUR je Firma und Monat aus dem heutigen Stufenmix` },
    ...(a.instanzen > 0 ? [{ bezeichnung: `Server-Instanzen (${a.instanzen})`, heuteCents: instanzCents, in12MonatenCents: instanzCents, hinweis: "Listenpreis je Instanz und Monat" }] : []),
  ];
  const listeHeute = posten.reduce((s, p) => s + p.heuteCents, 0);
  const liste12 = posten.reduce((s, p) => s + p.in12MonatenCents, 0);
  const direktHeute = Math.round(bestand * gewichteteKosten) + a.instanzen * a.instanzKosten;
  const direkt12 = Math.round(bestand12 * gewichteteKosten) + a.instanzen * a.instanzKosten;
  const spurMonate = reihe.filter((z) => z.spurkostenCents > 0);
  const spurMittel = spurMonate.length ? Math.round(spurMonate.reduce((s, z) => s + z.spurkostenCents, 0) / spurMonate.length) : 0;
  // Empfehlung: Listenpreis in 12 Monaten + 15 % Reserve, mindestens das Dreifache der
  // gerechneten Direktkosten in 12 Monaten; auf volle 50 EUR aufgerundet.
  const aufrunden = (c: number) => Math.ceil(c / 5000) * 5000;
  const mindest = aufrunden(Math.max(direkt12 * 3, direktHeute * 3));
  const empfehlung = Math.max(aufrunden(Math.round(liste12 * 1.15)), mindest);
  const limitVorschlag = aufrunden(Math.round(firmen12 * 1.25));
  const marge = empfehlung > 0 ? Math.round((1 - direkt12 / empfehlung) * 100) : 0;
  const gruende = [
    `Heute ${bestand} Firmen im Bestand bei ${seats} Nutzer${seats === 1 ? "" : "n"}; zu Listenpreisen entspraeche das ${(listeHeute / 100).toFixed(2)} EUR im Monat.`,
    `Der staerkste Monatszuwachs der letzten ${Math.max(1, reihe.length)} Monate war ${spitze} Firmen (im Mittel ${mittel}). Mit diesem Tempo liegt der Bestand in 12 Monaten bei ${bestand12} Firmen, zu Listenpreisen ${(liste12 / 100).toFixed(2)} EUR im Monat.`,
    `Darauf 15 % Reserve fuer Stufenwechsel (mehr LinkedIn-Profile, mehr Personen) und Auffrischungen, aufgerundet auf volle 50 EUR: ${(aufrunden(Math.round(liste12 * 1.15)) / 100).toFixed(2)} EUR.`,
    `Gegenprobe Direktkosten (Modell, Apify, Google-Suchen, Auffrischung${a.instanzen > 0 ? ", Server" : ""}): heute ${(direktHeute / 100).toFixed(2)} EUR, in 12 Monaten ${(direkt12 / 100).toFixed(2)} EUR im Monat. Der Fixpreis sollte mindestens das Dreifache davon tragen: ${(mindest / 100).toFixed(2)} EUR.`,
    spurMittel > 0
      ? `Gemessene Spurkosten dieses Kunden (Betreiber-Modell, Apify, Google): im Mittel ${(spurMittel / 100).toFixed(2)} EUR je Monat mit Daten; die Kalkulation liegt damit auf der sicheren Seite.`
      : "Fuer diesen Kunden sind noch keine Spurkosten gemessen (Betreiber-Spur seit 14.10.2026); die Kalkulation stuetzt sich auf die Kostenposten je Stufe.",
    `Empfohlener Fixpreis ${(empfehlung / 100).toFixed(2)} EUR im Monat, Marge auf die Direktkosten in 12 Monaten ${marge} %. Passendes Monatslimit fuer die Hintergrundverarbeitung: ${(limitVorschlag / 100).toFixed(2)} EUR zu Stufenpreisen (Bestand in 12 Monaten plus 25 %).`,
  ];
  return {
    instanzen: a.instanzen, seats, bestandHeute: bestand, zuwachsSpitzeJeMonat: spitze, zuwachsMittelJeMonat: mittel, bestandIn12Monaten: bestand12,
    mittlererStufenpreisCents: Math.round(gewichtet), posten, listenpreisHeuteCents: listeHeute, listenpreisIn12MonatenCents: liste12,
    direktkostenHeuteCents: direktHeute, direktkostenIn12MonatenCents: direkt12, spurkostenMittelCents: spurMittel,
    empfehlungCents: empfehlung, mindestpreisCents: mindest, limitVorschlagCents: limitVorschlag, margeBeiEmpfehlungProzent: marge, gruende,
  };
}

const de = (c: number) => (c / 100).toFixed(2).replace(".", ",");
const usdDe = (v: number) => v.toFixed(2).replace(".", ",");

/** CSV je Monat (Semikolon, deutsche Dezimaltrennung, UTF-8 mit BOM) fuer Buchhaltung und Vertrieb. */
export function kundeCsv(d: KundeDetail): string {
  const kopf = [
    "Monat", "Kunde", "Konto", "Plan", "Mitglieder",
    "Firmen klein", "Firmen mittel", "Firmen gross", "Firmen ohne Stufe", "Firmen gesamt",
    "Bestandswert zu Stufenpreisen EUR", "Firmenerloes EUR", "Seat-Erloes EUR", "Fixpreis EUR", "Erloes gesamt EUR",
    "Direktkosten gerechnet EUR", "Modellaufrufe Betreiber-Spur", "Modellkosten gerechnet USD", "Modellkosten laut OpenAI USD", "Apify-Laeufe", "Apify laut Anbieter USD", "Google-Suchen", "Google-Tarif", "Google USD", "Spurkosten EUR",
  ];
  const zeilen = d.monate.map((z) => [
    z.monat === "lifetime" ? "Free (lebenslang)" : z.monat, d.kunde.name, d.kunde.tenantId, d.kunde.tier, String(d.kunde.mitglieder),
    z.aufnahmen.klein, z.aufnahmen.mittel, z.aufnahmen.gross, z.aufnahmen.offen, z.bestand,
    de(z.bestandswertCents), de(z.firmenerloesCents), de(z.seatErloesCents), de(z.fixpreisCents), de(z.erloesCents),
    de(z.direktkostenCents), z.modellAufrufe, usdDe(z.modellUsd), z.modellUsdEcht == null ? "" : usdDe(z.modellUsdEcht), z.apifyLaeufe, usdDe(z.apifyUsd), z.serpSuchen, z.serpTarife.map((t) => `${t.tarif}: ${t.suchen}`).join(" | "), usdDe(z.serpUsd), de(z.spurkostenCents),
  ].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(";"));
  return "﻿" + [kopf.map((k) => `"${k}"`).join(";"), ...zeilen].join("\r\n") + "\r\n";
}

/** Kundensicht (Owner/Admin der Organisation): ohne interne Kosten und Spuren. */
export interface KundeKosten {
  konto: { tenantId: string; name: string; tier: string; mitglieder: number; ausgabenLimitCents: number | null; betreiberLimitCents: number | null; enterprisePreisCents: number | null };
  preise: Record<Stufe, { preisCents: number }>;
  verbrauch: { monat: string; bestandswertCents: number; limitCents: number | null; prozent: number | null };
  monate: Array<{ monat: string; aufnahmen: Record<Stufe | "offen", number>; bestand: number; bestandswertCents: number; firmenerloesCents: number; seatErloesCents: number; fixpreisCents: number; rechnungCents: number }>;
}

export function kundenSicht(d: KundeDetail): KundeKosten {
  const k = d.kunde;
  const heute = d.monate.find((m) => m.monat === aktuellePeriode());
  const limit = k.betreiberLimitCents != null && (k.ausgabenLimitCents == null || k.betreiberLimitCents <= k.ausgabenLimitCents) ? k.betreiberLimitCents : k.ausgabenLimitCents;
  const wert = heute?.bestandswertCents ?? 0;
  return {
    konto: { tenantId: k.tenantId, name: k.name, tier: k.tier, mitglieder: k.mitglieder, ausgabenLimitCents: k.ausgabenLimitCents, betreiberLimitCents: k.betreiberLimitCents, enterprisePreisCents: k.enterprisePreisCents },
    preise: { klein: { preisCents: d.preise.klein.preisCents }, mittel: { preisCents: d.preise.mittel.preisCents }, gross: { preisCents: d.preise.gross.preisCents } },
    verbrauch: { monat: aktuellePeriode(), bestandswertCents: wert, limitCents: limit, prozent: limit ? Math.min(100, Math.round((wert / limit) * 100)) : null },
    monate: d.monate.map((z) => ({ monat: z.monat, aufnahmen: z.aufnahmen, bestand: z.bestand, bestandswertCents: z.bestandswertCents, firmenerloesCents: z.firmenerloesCents, seatErloesCents: z.seatErloesCents, fixpreisCents: z.fixpreisCents, rechnungCents: z.erloesCents })),
  };
}

export function kundenCsv(k: KundeKosten): string {
  const kopf = ["Monat", "Organisation", "Plan", "Mitglieder", "Firmen klein", "Firmen mittel", "Firmen gross", "Firmen ohne Stufe", "Firmen gesamt", "Bestandswert zu Stufenpreisen EUR", "Firmen EUR", "Seats EUR", "Fixpreis EUR", "Rechnungsbetrag EUR"];
  const zeilen = k.monate.map((z) => [
    z.monat === "lifetime" ? "Free (lebenslang)" : z.monat, k.konto.name, k.konto.tier, String(k.konto.mitglieder),
    z.aufnahmen.klein, z.aufnahmen.mittel, z.aufnahmen.gross, z.aufnahmen.offen, z.bestand,
    de(z.bestandswertCents), de(z.firmenerloesCents), de(z.seatErloesCents), de(z.fixpreisCents), de(z.rechnungCents),
  ].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(";"));
  return "\uFEFF" + [kopf.map((x) => `"${x}"`).join(";"), ...zeilen].join("\r\n") + "\r\n";
}
