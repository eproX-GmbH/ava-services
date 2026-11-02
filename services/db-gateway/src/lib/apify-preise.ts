// docs/PLAN_PRICING_TIERS.md P4 (2026-11-02) — Preistabelle je Apify-Actor fuer die
// Schaetzung beim Aufruf und die Kundenkommunikation ("ab X € je 1.000").
//
// Quellen: Actor-Preise laut Apify-Store (harvestapi, Stand 2026-08/09, docs/
// KALKULATION_VERARBEITUNGSKOSTEN.md) plus Startgebuehr je Lauf. Alles per Env
// ueberschreibbar (APIFY_PREIS_<SCHLUESSEL>_USD_JE_1000, APIFY_STARTGEBUEHR_USD,
// APIFY_USD_EUR, LINKEDIN_AUFSCHLAG_PROZENT). Die echten Kosten kommen spaeter aus
// der Apify-API (anbieter-kosten.ts) und ersetzen die Schaetzung.

export interface ActorPreis {
  /** Schluessel fuer Env und Anzeige. */
  schluessel: string;
  /** Actor-ID in Tilde-Form (harvestapi~linkedin-post-reactions). */
  actorId: string;
  /** Was ein "Item" ist (fuer die Kundenanzeige). */
  einheit: string;
  /** USD je 1.000 Items (Actor-Preis). */
  usdJe1000: number;
  /** Zaehlt zur LinkedIn-Beobachtung (nach Verbrauch) oder zur Firmenverarbeitung (im Stufenpreis)? */
  beobachtung: boolean;
  /** Wie viele Items der Lauf hoechstens liefert, wenn der Aufruf kein maxItems nennt. */
  standardMaxItems: number;
}

const TABELLE: ActorPreis[] = [
  { schluessel: "POST_REACTIONS", actorId: "harvestapi~linkedin-post-reactions", einheit: "Reaktionen", usdJe1000: 2, beobachtung: true, standardMaxItems: 50 },
  { schluessel: "POST_COMMENTS", actorId: "harvestapi~linkedin-post-comments", einheit: "Kommentare", usdJe1000: 2, beobachtung: true, standardMaxItems: 50 },
  { schluessel: "PROFILE_REACTIONS", actorId: "harvestapi~linkedin-profile-reactions", einheit: "Reaktionen", usdJe1000: 2, beobachtung: true, standardMaxItems: 20 },
  { schluessel: "PROFILE_COMMENTS", actorId: "harvestapi~linkedin-profile-comments", einheit: "Kommentare", usdJe1000: 2, beobachtung: true, standardMaxItems: 20 },
  { schluessel: "PROFILE_SCRAPER", actorId: "harvestapi~linkedin-profile-scraper", einheit: "Profile", usdJe1000: 4, beobachtung: true, standardMaxItems: 10 },
  { schluessel: "COMPANY", actorId: "harvestapi~linkedin-company", einheit: "Firmenprofile", usdJe1000: 3, beobachtung: false, standardMaxItems: 1 },
  { schluessel: "COMPANY_SEARCH", actorId: "harvestapi~linkedin-company-search", einheit: "Treffer", usdJe1000: 3, beobachtung: false, standardMaxItems: 5 },
  { schluessel: "COMPANY_EMPLOYEES", actorId: "harvestapi~linkedin-company-employees", einheit: "Profile", usdJe1000: 8, beobachtung: false, standardMaxItems: 50 },
];

function env(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function startgebuehrUsd(): number {
  return env("APIFY_STARTGEBUEHR_USD", 0.02);
}
export function usdEur(): number {
  return env("APIFY_USD_EUR", 0.92);
}
/** Aufschlag auf die Apify-Kosten in Prozent (Joyce/Patrick/Henning 2026-11-01: 300). */
export function aufschlagProzent(): number {
  return env("LINKEDIN_AUFSCHLAG_PROZENT", 300);
}

export function actorPreise(): ActorPreis[] {
  return TABELLE.map((p) => ({ ...p, usdJe1000: env(`APIFY_PREIS_${p.schluessel}_USD_JE_1000`, p.usdJe1000) }));
}

export function actorPreis(actorId: string): ActorPreis | null {
  const norm = actorId.replace("/", "~").toLowerCase();
  return actorPreise().find((p) => p.actorId.toLowerCase() === norm) ?? null;
}

/** Items, die der Aufruf hoechstens liefert: maxItems × Zahl der Ziele (posts | profiles | companies). */
export function erwarteteItems(preis: ActorPreis | null, body: unknown): number {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const max = typeof b.maxItems === "number" && Number.isFinite(b.maxItems) ? Math.max(1, Math.round(b.maxItems)) : preis?.standardMaxItems ?? 50;
  const ziele = ["posts", "profiles", "companies", "urls", "profileUrls"].map((k) => (Array.isArray(b[k]) ? (b[k] as unknown[]).length : 0)).reduce((a, n) => Math.max(a, n), 0);
  return max * Math.max(1, ziele);
}

/** Geschaetzte Apify-Kosten eines Laufs in USD. */
export function schaetzeLaufUsd(actorId: string, body: unknown): number {
  const p = actorPreis(actorId);
  const items = erwarteteItems(p, body);
  const jeItem = (p?.usdJe1000 ?? 4) / 1000;
  return startgebuehrUsd() + items * jeItem;
}

/** Kundenpreis in Cent: USD → EUR, plus Aufschlag. */
export function kundenpreisCents(usd: number): number {
  return Math.max(1, Math.round(usd * usdEur() * (1 + aufschlagProzent() / 100) * 100));
}

/** Kundenpreistabelle fuer die Anzeige ("ab X € je 1.000 Reaktionen"). */
export function kundenPreistabelle(): Array<{ schluessel: string; einheit: string; centsJe1000: number; centsJeLauf: number; beobachtung: boolean }> {
  return actorPreise().map((p) => ({
    schluessel: p.schluessel,
    einheit: p.einheit,
    centsJe1000: kundenpreisCents(p.usdJe1000),
    centsJeLauf: kundenpreisCents(startgebuehrUsd()),
    beobachtung: p.beobachtung,
  }));
}
