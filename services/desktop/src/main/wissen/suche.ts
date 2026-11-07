// Loesungskarten (docs/PLAN_LOESUNGSKARTEN.md, L3): Suche.
// Volltext nach BM25 ueber gewichtete Felder (Titel > Fragen/Schlagworte >
// Loesung), optional nachsortiert mit lokalen Vektoren (Ollama, Titel + Fragen
// je Karte, einmal je Kartenstand berechnet). Ohne Ollama bleibt es beim
// Volltext. Die Zusammenfuehrung laeuft ueber Rangfusion (RRF).

import type { Karte } from "./format";

const GEWICHT = { titel: 3, fragen: 2, schlagworte: 2, loesung: 1 } as const;
const K1 = 1.2;
const B = 0.75;
const RRF_K = 60;

const STOPP = new Set(
  "der die das den dem des ein eine einen einem einer eines und oder aber auch nicht kein keine ist sind war bin bist hat habe haben wird werden kann kannst koennen moechte will wie was wer wo wann warum wieso mit fuer von zu zum zur im in am an auf aus bei nach ueber unter vor so da dann denn doch mal mir mich dir dich mein meine meinen meiner dein deine ich du er sie es wir ihr man sich bitte gerne gern hier dort noch schon nur sehr ja nein ob als".split(" "),
);

/** Deutsch: klein, Umlaute falten, Stoppwoerter raus, leichte Endungskuerzung. */
export function tokens(text: string): string[] {
  const t = text
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOPP.has(w));
  return t.map(stamm);
}

function stamm(w: string): string {
  if (w.length <= 4) return w;
  for (const s of ["ierungen", "ierung", "ungen", "ieren", "iert", "erer", "eres", "ung", "en", "er", "es", "e", "n", "s"]) {
    if (w.endsWith(s) && w.length - s.length >= 4) return w.slice(0, -s.length);
  }
  return w;
}

interface Dok {
  karte: Karte;
  tf: Map<string, number>;
  laenge: number;
  vektorText: string;
}

export interface Treffer {
  karte: Karte;
  /** 0..1, relativ zum besten Treffer dieser Suche. */
  relevanz: number;
  bm25: number;
  kosinus?: number;
}

export type Einbetter = (texte: string[]) => Promise<number[][] | null>;

export class WissensIndex {
  private readonly doks: Dok[];
  private readonly df = new Map<string, number>();
  private readonly mittlereLaenge: number;
  private vektoren: number[][] | null = null;
  private vektorenLaden: Promise<void> | null = null;

  constructor(
    readonly karten: Karte[],
    private readonly einbetten?: Einbetter,
  ) {
    this.doks = karten.map((k) => {
      const tf = new Map<string, number>();
      let laenge = 0;
      const feld = (text: string, g: number) => {
        for (const w of tokens(text)) {
          tf.set(w, (tf.get(w) ?? 0) + g);
          laenge += g;
        }
      };
      feld(k.titel, GEWICHT.titel);
      feld(k.fragen.join(" \n "), GEWICHT.fragen);
      feld(k.schlagworte.join(" "), GEWICHT.schlagworte);
      feld(k.loesung, GEWICHT.loesung);
      for (const w of tf.keys()) this.df.set(w, (this.df.get(w) ?? 0) + 1);
      return { karte: k, tf, laenge, vektorText: [k.titel, ...k.fragen].join("\n") };
    });
    this.mittlereLaenge = this.doks.reduce((s, d) => s + d.laenge, 0) / Math.max(1, this.doks.length);
  }

  get anzahl(): number {
    return this.doks.length;
  }

  private bm25(abfrage: string[]): number[] {
    const n = this.doks.length;
    return this.doks.map((d) => {
      let s = 0;
      for (const w of new Set(abfrage)) {
        const f = d.tf.get(w);
        if (!f) continue;
        const df = this.df.get(w) ?? 0;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        s += idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * d.laenge) / this.mittlereLaenge)));
      }
      return s;
    });
  }

  /** Kartenvektoren einmal je Index berechnen; Fehler = ohne Vektoren weiter. */
  private async vektorenSicherstellen(): Promise<void> {
    if (this.vektoren || !this.einbetten || this.doks.length === 0) return;
    this.vektorenLaden ??= (async () => {
      const v = await this.einbetten!(this.doks.map((d) => d.vektorText)).catch(() => null);
      if (v && v.length === this.doks.length) this.vektoren = v;
      else this.vektorenLaden = null; // spaeter erneut versuchen (Ollama startet evtl. noch)
    })();
    await this.vektorenLaden;
  }

  async suchen(frage: string, opts: { limit?: number; kanal?: "desktop" | "telegram" | "app" } = {}): Promise<Treffer[]> {
    const limit = opts.limit ?? 3;
    const passt = (k: Karte) => !opts.kanal || k.gilt_fuer.includes("alle") || k.gilt_fuer.includes(opts.kanal);
    const bm = this.bm25(tokens(frage));

    let kos: number[] | null = null;
    if (this.einbetten) {
      await this.vektorenSicherstellen();
      if (this.vektoren) {
        const q = await this.einbetten([frage]).catch(() => null);
        if (q?.[0]) kos = this.vektoren.map((v) => kosinus(q[0]!, v));
      }
    }

    const idx = this.doks.map((_, i) => i).filter((i) => passt(this.doks[i]!.karte));
    const bmRang = rangVon(idx.filter((i) => bm[i]! > 0), (i) => bm[i]!);
    const kosRang = kos ? rangVon(idx.filter((i) => kos![i]! >= KOSINUS_MIN), (i) => kos![i]!) : new Map<number, number>();
    const kandidaten = new Set([...bmRang.keys(), ...kosRang.keys()]);
    const wertung = [...kandidaten].map((i) => ({
      i,
      rrf: (bmRang.has(i) ? 1 / (RRF_K + bmRang.get(i)!) : 0) + (kosRang.has(i) ? VEKTOR_GEWICHT / (RRF_K + kosRang.get(i)!) : 0),
    }));
    wertung.sort((a, b) => b.rrf - a.rrf);
    const top = wertung.slice(0, limit);
    const bester = top[0]?.rrf ?? 1;
    return top.map(({ i, rrf }) => ({
      karte: this.doks[i]!.karte,
      relevanz: Math.round((rrf / bester) * 100) / 100,
      bm25: Math.round(bm[i]! * 100) / 100,
      ...(kos ? { kosinus: Math.round(kos[i]! * 100) / 100 } : {}),
    }));
  }
}

/** Unterhalb davon gilt ein reiner Vektortreffer (ohne gemeinsames Wort) als Rauschen. */
// Messung 2026-11-07 (291 Karten): Pruefsatz 239 Fragen Volltext 233, mit
// Vektoren 228; zurueckgehaltener Satz mit 25 frei formulierten Fragen Volltext
// 21/25, mit Vektoren 24/25. Vektoren also voll gewichten, nur reine
// Vektortreffer ohne gemeinsames Wort erst ab 0,55 zulassen.
const KOSINUS_MIN = 0.55;
const VEKTOR_GEWICHT = 1;

function rangVon(ids: number[], wert: (i: number) => number): Map<number, number> {
  const sortiert = [...ids].sort((a, b) => wert(b) - wert(a));
  return new Map(sortiert.map((i, r) => [i, r + 1]));
}

function kosinus(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
}
