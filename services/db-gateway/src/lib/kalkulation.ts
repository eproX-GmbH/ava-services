// Z5/Z11 — Kalkulation der Verarbeitungskosten fuer die Betreiber-Seite der
// Admin-Konsole (admin.ava.bi → Verarbeitungskosten). Kostenposten je Stufe und
// Fixkosten des Betreibers; Preise kommen aus lib/stufen.ts (Env), Tarif (Seat,
// Instanz) aus Env. Stand der Messung: 13.10.2026, Pool-Modell gpt-6-luna.

export interface Kostenposten {
  stufe: "klein" | "mittel" | "gross";
  block: "valueserp" | "apify" | "modell" | "auffrischung";
  posten: string;
  menge: number;
  einheit: string;
  preisUsdJeEinheit: number;
  kostenUsd: number;
  kostenEur: number;
  laufend: boolean;
  annahme: string;
  quelle: string;
}

export interface Fixkosten {
  posten: string;
  groesse: string;
  usdMonat: number;
  eurMonat: number;
  hinweis: string;
}

export const KOSTENPOSTEN: Kostenposten[] = [
  {"stufe": "klein", "block": "valueserp", "posten": "Website-Suche (Website-Producer)", "menge": 1.5, "einheit": "Suchen", "preisUsdJeEinheit": 0.0025, "kostenUsd": 0.0037, "kostenEur": 0.0034, "laufend": false, "annahme": "1 Suche, bei Fehlschlag Wiederholung", "quelle": "Code website/valueserp-utils.ts; Preis 2,50 $/1.000 (Pay-as-you-go)"},
  {"stufe": "klein", "block": "valueserp", "posten": "SERP-Rueckfall Kontakte (Crawl < 5 Personen)", "menge": 4, "einheit": "Suchen", "preisUsdJeEinheit": 0.0025, "kostenUsd": 0.01, "kostenEur": 0.0092, "laufend": false, "annahme": "bis 6 Suchen, im Mittel 4", "quelle": "Code company-contact compute-worker.ts:923 (limit 6)"},
  {"stufe": "klein", "block": "valueserp", "posten": "LinkedIn-URL-Suche je Person", "menge": 2, "einheit": "Suchen", "preisUsdJeEinheit": 0.0025, "kostenUsd": 0.005, "kostenEur": 0.0046, "laufend": false, "annahme": "nur auf Anfrage, wenige Personen", "quelle": "Code valueserp.ts lookupLinkedInProfile"},
  {"stufe": "klein", "block": "auffrischung", "posten": "Website-Stufe alle 30 Tage", "menge": 1, "einheit": "Suchen/Monat", "preisUsdJeEinheit": 0.0025, "kostenUsd": 0.0025, "kostenEur": 0.0023, "laufend": true, "annahme": "laufend je Bestandsfirma", "quelle": "Auffrischung (freshness-prefs-store.ts)"},
  {"stufe": "mittel", "block": "valueserp", "posten": "Website-Suche (Website-Producer)", "menge": 1.5, "einheit": "Suchen", "preisUsdJeEinheit": 0.0025, "kostenUsd": 0.0037, "kostenEur": 0.0034, "laufend": false, "annahme": "1 Suche, bei Fehlschlag Wiederholung", "quelle": "Code website/valueserp-utils.ts"},
  {"stufe": "mittel", "block": "valueserp", "posten": "Domain-Verifikation Firmenprofil", "menge": 1, "einheit": "Suchen", "preisUsdJeEinheit": 0.0025, "kostenUsd": 0.0025, "kostenEur": 0.0023, "laufend": false, "annahme": "1 Suche je Firma (apify-company.ts:495)", "quelle": "Code apify-company.ts"},
  {"stufe": "mittel", "block": "valueserp", "posten": "LinkedIn-URL-Suche je Person", "menge": 5, "einheit": "Suchen", "preisUsdJeEinheit": 0.0025, "kostenUsd": 0.0125, "kostenEur": 0.0115, "laufend": false, "annahme": "Personen ohne URL aus Apify", "quelle": "Code valueserp.ts lookupLinkedInProfile"},
  {"stufe": "mittel", "block": "apify", "posten": "Firmensuche (harvestapi~linkedin-company-search)", "menge": 1, "einheit": "Lauf", "preisUsdJeEinheit": 0.023, "kostenUsd": 0.023, "kostenEur": 0.0212, "laufend": false, "annahme": "1 Ergebnis a 3 $/1.000 + 0,02 $ Startgebuehr", "quelle": "Aktor-Preis laut Vergleichsseiten; Startgebuehr 0,02 $/Lauf"},
  {"stufe": "mittel", "block": "apify", "posten": "Firmendetails (harvestapi~linkedin-company)", "menge": 1, "einheit": "Lauf", "preisUsdJeEinheit": 0.023, "kostenUsd": 0.023, "kostenEur": 0.0212, "laufend": false, "annahme": "1 Ergebnis a 3 $/1.000 + 0,02 $ Startgebuehr", "quelle": "Aktor-Preis laut Vergleichsseiten"},
  {"stufe": "mittel", "block": "apify", "posten": "Mitarbeiter-Fenster 100 (harvestapi~linkedin-company-employees, Short)", "menge": 100, "einheit": "Ergebnisse", "preisUsdJeEinheit": 0.004, "kostenUsd": 0.4, "kostenEur": 0.368, "laufend": false, "annahme": "Fenster 100 (APIFY_COMPANY_FENSTER), 4 $/1.000", "quelle": "Code-Kommentar apify-company.ts (2026-08-31)"},
  {"stufe": "mittel", "block": "apify", "posten": "Startgebuehr Mitarbeiter-Lauf", "menge": 1, "einheit": "Lauf", "preisUsdJeEinheit": 0.02, "kostenUsd": 0.02, "kostenEur": 0.0184, "laufend": false, "annahme": "0,02 $ je Lauf", "quelle": "Apify-Plattform"},
  {"stufe": "mittel", "block": "apify", "posten": "Plattform-Rechenzeit (CU)", "menge": 0.15, "einheit": "CU", "preisUsdJeEinheit": 0.2, "kostenUsd": 0.03, "kostenEur": 0.0276, "laufend": false, "annahme": "~0,15 CU je Firma a 0,20 $/CU (Free/Starter)", "quelle": "Apify-Preisliste"},
  {"stufe": "mittel", "block": "auffrischung", "posten": "Website-Stufe alle 30 Tage", "menge": 1, "einheit": "Suchen/Monat", "preisUsdJeEinheit": 0.0025, "kostenUsd": 0.0025, "kostenEur": 0.0023, "laufend": true, "annahme": "laufend je Bestandsfirma", "quelle": "Auffrischung"},
  {"stufe": "mittel", "block": "auffrischung", "posten": "Kontakt-Stufe alle 90 Tage (Apify erneut)", "menge": 0.33, "einheit": "Laeufe/Monat", "preisUsdJeEinheit": 0.49, "kostenUsd": 0.1617, "kostenEur": 0.1488, "laufend": true, "annahme": "ein Drittel der Apify-Kosten je Monat", "quelle": "Auffrischung, Kontakt-Takt 90 Tage"},
  {"stufe": "gross", "block": "valueserp", "posten": "Website-Suche (Website-Producer)", "menge": 1.5, "einheit": "Suchen", "preisUsdJeEinheit": 0.0025, "kostenUsd": 0.0037, "kostenEur": 0.0034, "laufend": false, "annahme": "1 Suche, bei Fehlschlag Wiederholung", "quelle": "Code website/valueserp-utils.ts"},
  {"stufe": "gross", "block": "valueserp", "posten": "Domain-Verifikation Firmenprofil", "menge": 1, "einheit": "Suchen", "preisUsdJeEinheit": 0.0025, "kostenUsd": 0.0025, "kostenEur": 0.0023, "laufend": false, "annahme": "1 Suche je Firma", "quelle": "Code apify-company.ts"},
  {"stufe": "gross", "block": "valueserp", "posten": "LinkedIn-URL-Suche je Person", "menge": 12, "einheit": "Suchen", "preisUsdJeEinheit": 0.0025, "kostenUsd": 0.03, "kostenEur": 0.0276, "laufend": false, "annahme": "viele Personen ohne URL", "quelle": "Code valueserp.ts"},
  {"stufe": "gross", "block": "apify", "posten": "Firmensuche (harvestapi~linkedin-company-search)", "menge": 1, "einheit": "Lauf", "preisUsdJeEinheit": 0.023, "kostenUsd": 0.023, "kostenEur": 0.0212, "laufend": false, "annahme": "wie mittel", "quelle": "Aktor-Preis"},
  {"stufe": "gross", "block": "apify", "posten": "Firmendetails (harvestapi~linkedin-company)", "menge": 1, "einheit": "Lauf", "preisUsdJeEinheit": 0.023, "kostenUsd": 0.023, "kostenEur": 0.0212, "laufend": false, "annahme": "wie mittel", "quelle": "Aktor-Preis"},
  {"stufe": "gross", "block": "apify", "posten": "Mitarbeiter-Fenster 100 (Short)", "menge": 100, "einheit": "Ergebnisse", "preisUsdJeEinheit": 0.004, "kostenUsd": 0.4, "kostenEur": 0.368, "laufend": false, "annahme": "Fenster voll", "quelle": "Code apify-company.ts"},
  {"stufe": "gross", "block": "apify", "posten": "Gezielter Zweitlauf Fuehrungsrollen (25)", "menge": 25, "einheit": "Ergebnisse", "preisUsdJeEinheit": 0.004, "kostenUsd": 0.1, "kostenEur": 0.092, "laufend": false, "annahme": "nur wenn Fenster voll ohne Fuehrungsrolle", "quelle": "Code compute-worker.ts:855"},
  {"stufe": "gross", "block": "apify", "posten": "Startgebuehren (2 Mitarbeiter-Laeufe)", "menge": 2, "einheit": "Lauf", "preisUsdJeEinheit": 0.02, "kostenUsd": 0.04, "kostenEur": 0.0368, "laufend": false, "annahme": "0,02 $ je Lauf", "quelle": "Apify-Plattform"},
  {"stufe": "gross", "block": "apify", "posten": "Plattform-Rechenzeit (CU)", "menge": 0.25, "einheit": "CU", "preisUsdJeEinheit": 0.2, "kostenUsd": 0.05, "kostenEur": 0.046, "laufend": false, "annahme": "~0,25 CU je Firma", "quelle": "Apify-Preisliste"},
  {"stufe": "gross", "block": "auffrischung", "posten": "Website-Stufe alle 30 Tage", "menge": 1, "einheit": "Suchen/Monat", "preisUsdJeEinheit": 0.0025, "kostenUsd": 0.0025, "kostenEur": 0.0023, "laufend": true, "annahme": "laufend", "quelle": "Auffrischung"},
  {"stufe": "gross", "block": "auffrischung", "posten": "Kontakt-Stufe alle 90 Tage (Apify erneut)", "menge": 0.33, "einheit": "Laeufe/Monat", "preisUsdJeEinheit": 0.6, "kostenUsd": 0.198, "kostenEur": 0.1822, "laufend": true, "annahme": "ein Drittel der Apify-Kosten je Monat", "quelle": "Auffrischung"},
  {"stufe": "klein", "block": "modell", "posten": "Betreiber-Modell Pool-Stufen (gpt-6-luna)", "menge": 120, "einheit": "Aufrufe", "preisUsdJeEinheit": 0.0008, "kostenUsd": 0.096, "kostenEur": 0.0883, "laufend": false, "annahme": "Website-Judge, Profil, Kontakt-Extraktion aus dem Crawl, E-Mail-Urteil; weniger Aufrufe ohne LinkedIn-Personen", "quelle": "LlmUsage: gpt-6-luna 0,0008 $/Aufruf (1.609 Aufrufe, 1,23 $), 159 Aufrufe je Firma; Plan Abrechnung Zugang Z1/Z2"},
  {"stufe": "klein", "block": "auffrischung", "posten": "Betreiber-Modell bei Auffrischung (anteilig je Monat)", "menge": 48.0, "einheit": "Aufrufe/Monat", "preisUsdJeEinheit": 0.0008, "kostenUsd": 0.0384, "kostenEur": 0.0353, "laufend": true, "annahme": "Website-Stufe monatlich, Kontakt-Stufe alle 90 Tage: ~40 % der Erstaufrufe je Monat", "quelle": "Auffrischungs-Takte (freshness-prefs-store.ts)"},
  {"stufe": "mittel", "block": "modell", "posten": "Betreiber-Modell Pool-Stufen (gpt-6-luna)", "menge": 160, "einheit": "Aufrufe", "preisUsdJeEinheit": 0.0008, "kostenUsd": 0.128, "kostenEur": 0.1178, "laufend": false, "annahme": "gemessen: 159 Aufrufe je Firma (Sept. 2026) ueber alle Pool-Stufen", "quelle": "LlmUsage: gpt-6-luna 0,0008 $/Aufruf (1.609 Aufrufe, 1,23 $), 159 Aufrufe je Firma; Plan Abrechnung Zugang Z1/Z2"},
  {"stufe": "mittel", "block": "auffrischung", "posten": "Betreiber-Modell bei Auffrischung (anteilig je Monat)", "menge": 64.0, "einheit": "Aufrufe/Monat", "preisUsdJeEinheit": 0.0008, "kostenUsd": 0.0512, "kostenEur": 0.0471, "laufend": true, "annahme": "Website-Stufe monatlich, Kontakt-Stufe alle 90 Tage: ~40 % der Erstaufrufe je Monat", "quelle": "Auffrischungs-Takte (freshness-prefs-store.ts)"},
  {"stufe": "gross", "block": "modell", "posten": "Betreiber-Modell Pool-Stufen (gpt-6-luna)", "menge": 200, "einheit": "Aufrufe", "preisUsdJeEinheit": 0.0008, "kostenUsd": 0.16, "kostenEur": 0.1472, "laufend": false, "annahme": "mehr Personen (Rollen, E-Mail-Urteile) und Publikations-Auswertung", "quelle": "LlmUsage: gpt-6-luna 0,0008 $/Aufruf (1.609 Aufrufe, 1,23 $), 159 Aufrufe je Firma; Plan Abrechnung Zugang Z1/Z2"},
  {"stufe": "gross", "block": "auffrischung", "posten": "Betreiber-Modell bei Auffrischung (anteilig je Monat)", "menge": 80.0, "einheit": "Aufrufe/Monat", "preisUsdJeEinheit": 0.0008, "kostenUsd": 0.064, "kostenEur": 0.0589, "laufend": true, "annahme": "Website-Stufe monatlich, Kontakt-Stufe alle 90 Tage: ~40 % der Erstaufrufe je Monat", "quelle": "Auffrischungs-Takte (freshness-prefs-store.ts)"},
];

export const FIXKOSTEN: Fixkosten[] = [
  {"posten": "ava-db-gateway", "groesse": "shared-1cpu, 512 MB", "usdMonat": 3.19, "eurMonat": 2.93, "hinweis": "Fly-Listenpreis"},
  {"posten": "ava-master-data", "groesse": "shared-1cpu, 1 GB", "usdMonat": 5.7, "eurMonat": 5.24, "hinweis": "Fly-Listenpreis"},
  {"posten": "ava-register-worker", "groesse": "shared-1cpu, 2 GB laufend + 2 gestoppte", "usdMonat": 11.0, "eurMonat": 10.12, "hinweis": "Fly-Listenpreis, gestoppte nur Rootfs"},
  {"posten": "headless-ava (Operator-Instanz)", "groesse": "shared-2cpu, 4 GB + Volume", "usdMonat": 23.0, "eurMonat": 21.16, "hinweis": "Fly-Listenpreis"},
  {"posten": "ava-router (2x) + ava-pgbouncer", "groesse": "3 x 256 MB", "usdMonat": 6.0, "eurMonat": 5.52, "hinweis": "Fly-Listenpreis"},
  {"posten": "Keycloak", "groesse": "shared-2cpu, 1 GB", "usdMonat": 7.5, "eurMonat": 6.9, "hinweis": "Fly-Listenpreis"},
  {"posten": "Managed Postgres ava-db", "groesse": "Basic, 1 Replikat, 20 GB", "usdMonat": 44.0, "eurMonat": 40.48, "hinweis": "38 $ Plan + 20 GB x 0,30 $"},
  {"posten": "Elasticsearch Serverless", "groesse": "monatlicher Sammel-Abgleich", "usdMonat": 0, "eurMonat": 0.0, "hinweis": "unbekannt: Rechnung eintragen"},
  {"posten": "CloudAMQP", "groesse": "Plan unbekannt", "usdMonat": 0, "eurMonat": 0.0, "hinweis": "unbekannt: 0-19 $"},
  {"posten": "GitHub Actions", "groesse": "Repo oeffentlich", "usdMonat": 0, "eurMonat": 0.0, "hinweis": "kostenlos"},
];

function eurEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Tarifbausteine neben dem Stufensatz (Preis und Direktkosten je Monat, Euro). */
export function tarif(): Array<{ posten: "seat" | "instanz"; bezeichnung: string; preisEur: number; kostenEur: number; hinweis: string }> {
  return [
    { posten: "seat", bezeichnung: "Pro-Seat je Nutzer und Monat", preisEur: eurEnv("SEAT_PRICE_PRO_CENTS", 4900) / 100, kostenEur: 0, hinweis: "Grundgebuehr; Chat, Radar, Recherche laufen ueber das Modell des Kunden" },
    { posten: "instanz", bezeichnung: "Server-Instanz je Monat", preisEur: eurEnv("INSTANZ_PREIS_CENTS", 5900) / 100, kostenEur: eurEnv("INSTANZ_KOSTEN_CENTS", 3400) / 100, hinweis: "Fly shared-2cpu 4 GB Kopf + Volume (23 $) plus Ollama-Sidecar fuer Embeddings (ca. 14 $) = ca. 37 $ ≈ 34 €" },
  ];
}

/** Direktkosten je Stufe: einmalig je Erstverarbeitung, laufend je Monat (Auffrischung),
 *  je Bestandsfirma und Monat (Erstverarbeitung auf 12 Monate umgelegt plus laufend). */
export function direktJeStufe(): Array<{ stufe: "klein" | "mittel" | "gross"; einmaligEur: number; laufendEurMonat: number; bestandEurMonat: number }> {
  return (["klein", "mittel", "gross"] as const).map((stufe) => {
    const rows = KOSTENPOSTEN.filter((r) => r.stufe === stufe);
    const einmalig = rows.filter((r) => !r.laufend).reduce((s, r) => s + r.kostenEur, 0);
    const laufend = rows.filter((r) => r.laufend).reduce((s, r) => s + r.kostenEur, 0);
    return { stufe, einmaligEur: Math.round(einmalig * 1000) / 1000, laufendEurMonat: Math.round(laufend * 1000) / 1000, bestandEurMonat: Math.round((einmalig / 12 + laufend) * 1000) / 1000 };
  });
}
