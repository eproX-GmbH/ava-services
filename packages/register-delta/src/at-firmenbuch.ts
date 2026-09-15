// Oesterreich, Weg 1 (docs/PLAN_OESTERREICH.md): Firmenbuch-Stammdaten ueber
// die JSON-API von JustizOnline (ohne Browser, ohne Login).
//
//   Suche   GET /jop/service/fba/search?term&size=10&page&state&court
//           `term` trifft auch die Firmenbuchnummer als Teilzeichenkette; da
//           jede Nummer auf <Ziffer><Pruefbuchstabe> endet, ist die Vereinigung
//           der 260 Begriffe je Gericht vollstaendig (Notebook §4a).
//   Detail  GET /jop/service/fba/<fnr>_<n>   (Rechtsform, Adresse, Status)
//   Takt    3/s → 429 mit Retry-After 10; 0,5/s laeuft stundenlang ohne Sperre.

export const JUSTIZONLINE_API = "https://justizonline.gv.at/jop/service/fba";
export const AT_ABFRAGEN_JE_STUNDE = 1800; // 0,5 je Sekunde
export const AT_SUCHE_SEITE = 10; // hoechstens 10 je Seite (size=11 → Fehler)

/** Gerichte laut filterConfig (Id → Name, Bundesland). */
export const AT_GERICHTE: Record<string, { name: string; bundesland: string }> = {
  "007": { name: "Handelsgericht Wien", bundesland: "Wien" },
  "309": { name: "Landesgericht Eisenstadt", bundesland: "Burgenland" },
  "929": { name: "Landesgericht Feldkirch", bundesland: "Vorarlberg" },
  "638": { name: "Landesgericht für ZRS Graz", bundesland: "Steiermark" },
  "818": { name: "Landesgericht Innsbruck", bundesland: "Tirol" },
  "729": { name: "Landesgericht Klagenfurt", bundesland: "Kärnten" },
  "119": { name: "Landesgericht Korneuburg", bundesland: "Niederösterreich" },
  "129": { name: "Landesgericht Krems an der Donau", bundesland: "Niederösterreich" },
  "609": { name: "Landesgericht Leoben", bundesland: "Steiermark" },
  "458": { name: "Landesgericht Linz", bundesland: "Oberösterreich" },
  "469": { name: "Landesgericht Ried im Innkreis", bundesland: "Oberösterreich" },
  "569": { name: "Landesgericht Salzburg", bundesland: "Salzburg" },
  "499": { name: "Landesgericht Steyr", bundesland: "Oberösterreich" },
  "199": { name: "Landesgericht St. Pölten", bundesland: "Niederösterreich" },
  "519": { name: "Landesgericht Wels", bundesland: "Oberösterreich" },
  "239": { name: "Landesgericht Wiener Neustadt", bundesland: "Niederösterreich" },
};

/** Alle 260 Suffix-Begriffe <Ziffer><Buchstabe>; leere Begriffe kosten je eine Anfrage. */
export const AT_BEGRIFFE: string[] = [];
for (const z of "0123456789") for (const b of "abcdefghijklmnopqrstuvwxyz") AT_BEGRIFFE.push(`${z}${b}`);

const FN_RE = /^(\d{1,6})([a-z])$/;

/** companyId-Regel: AT_FN + Nummer ohne fuehrende Nullen + Pruefbuchstabe gross. */
export function companyIdAt(fnr: string): string {
  const m = FN_RE.exec(fnr.trim().toLowerCase().replace(/^fn\s*/, ""));
  if (!m) throw new Error(`ungueltige Firmenbuchnummer: ${fnr}`);
  return `AT_FN${Number(m[1])}${m[2].toUpperCase()}`;
}

export function istFirmenbuchnummer(fnr: string): boolean {
  return FN_RE.test(fnr.trim().toLowerCase().replace(/^fn\s*/, ""));
}

export type AtSuchtreffer = { id: string; fnr: string; status: string; name: string; domicile: string | null };
export type AtDetail = AtSuchtreffer & {
  legalForm?: { abbr?: string; name?: string } | null;
  address?: { zipCode?: string; street?: string; city?: string } | null;
};

/** Ergebniszeile fuer das Gateway (Treffer der Art at). */
export type TrefferAt = {
  fnr: string;
  name: string;
  sitz: string;
  status: "ACTIVE" | "CLOSED";
  gericht: string;
  bundesland: string;
  legalForm?: string | null;
  uid?: string | null;
};

export function trefferAt(t: AtSuchtreffer | AtDetail, gerichtId: string): TrefferAt {
  const g = AT_GERICHTE[gerichtId] ?? { name: `Gericht ${gerichtId}`, bundesland: "" };
  const d = t as AtDetail;
  return {
    fnr: t.fnr.trim().toLowerCase(),
    name: t.name.trim(),
    sitz: (t.domicile ?? d.address?.city ?? "").trim(),
    status: t.status === "DELETED" ? "CLOSED" : "ACTIVE",
    gericht: g.name,
    bundesland: g.bundesland,
    legalForm: d.legalForm?.name?.trim() || undefined,
  };
}

export type AtSuchseite = { treffer: AtSuchtreffer[]; gesamt: number; gesperrt: boolean };

export type JustizOnlineOptionen = {
  fetchImpl?: typeof fetch;
  log?: (zeile: string) => void;
  /** Wartefunktion (Tests). */
  schlafen?: (ms: number) => Promise<void>;
};

/**
 * Duenner Client: keine Taktung hier (die macht der Taktgeber des Jobs), aber
 * 429 wird mit Retry-After (Default 10 s) einmal wiederholt; ein zweites 429
 * gilt als Sperre und der Job geht zurueck in die Queue.
 */
export class JustizOnlineClient {
  private readonly f: typeof fetch;
  private readonly schlafen: (ms: number) => Promise<void>;
  constructor(private readonly o: JustizOnlineOptionen = {}) {
    this.f = o.fetchImpl ?? fetch;
    this.schlafen = o.schlafen ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private async get(path: string, params?: Record<string, string>): Promise<{ status: number; body: unknown }> {
    const url = new URL(`${JUSTIZONLINE_API}/${path}`);
    for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v);
    for (let versuch = 0; ; versuch++) {
      const res = await this.f(url.toString(), { headers: { accept: "application/json", "user-agent": "AVA-Recherche (Kontakt: joyce@quikk.de)" } });
      if (res.status === 429 && versuch === 0) {
        const wart = Math.min(60, Math.max(1, Number(res.headers.get("retry-after") ?? 10)));
        this.o.log?.(`justizonline 429, warte ${wart} s`);
        await this.schlafen(wart * 1000);
        continue;
      }
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      return { status: res.status, body };
    }
  }

  /** Eine Suchseite (10 Treffer). state ACTIVE | DELETED | ALL. */
  async suche(term: string, page: number, gerichtId?: string, state = "ACTIVE"): Promise<AtSuchseite> {
    const params: Record<string, string> = { term, size: String(AT_SUCHE_SEITE), page: String(page), state };
    if (gerichtId) params.court = gerichtId;
    const r = await this.get("search", params);
    if (r.status === 429) return { treffer: [], gesamt: 0, gesperrt: true };
    if (r.status !== 200 || !r.body || typeof r.body !== "object") throw new Error(`justizonline search ${r.status}`);
    const b = r.body as { numResults?: number; companies?: AtSuchtreffer[] | null };
    return { treffer: (b.companies ?? []).filter((c) => c && typeof c.fnr === "string" && typeof c.name === "string"), gesamt: Number(b.numResults ?? 0), gesperrt: false };
  }

  /** Aktuelle Version einer Firma; null = unbekannt (404). Versionen `<fnr>_<n>` sind historisch, `<fnr>_1` immer vorhanden. */
  async detail(fnr: string): Promise<{ detail: AtDetail | null; gesperrt: boolean }> {
    // Die Suche liefert die Id der aktuellen Version (z. B. 56247t_17); ohne sie
    // die hoechste Version ueber die Suche nach der Nummer ermitteln.
    const s = await this.suche(fnr, 0, undefined, "ALL");
    if (s.gesperrt) return { detail: null, gesperrt: true };
    const exakt = s.treffer.find((t) => t.fnr.toLowerCase() === fnr.toLowerCase());
    if (!exakt) return { detail: null, gesperrt: false };
    const r = await this.get(exakt.id);
    if (r.status === 429) return { detail: null, gesperrt: true };
    if (r.status === 404) return { detail: null, gesperrt: false };
    if (r.status !== 200 || !r.body || typeof r.body !== "object") throw new Error(`justizonline detail ${r.status}`);
    return { detail: r.body as AtDetail, gesperrt: false };
  }
}
