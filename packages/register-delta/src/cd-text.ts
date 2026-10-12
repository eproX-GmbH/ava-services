// PDF des chronologischen Abdrucks → Textstuecke mit Position (cd-parser.ts).
// pdfjs-dist 5 (Legacy-Build, ESM) laeuft ohne native Abhaengigkeit im
// Betreiber-Worker (Alpine, Node 20) und in der Desktop-App; gerendert wird
// nichts, nur der Textinhalt gelesen.

import type { CdSeite } from "./cd-parser";

/** Hoechstgroesse einer CD-Datei; echte Abdrucke liegen bei 30 bis 500 KB. */
export const CD_MAX_BYTES = 20 * 1024 * 1024;
const MAX_SEITEN = 60;

type PdfjsModul = {
  getDocument(src: { data: Uint8Array; useSystemFonts?: boolean; isEvalSupported?: boolean; disableFontFace?: boolean }): {
    promise: Promise<{
      numPages: number;
      getPage(n: number): Promise<{
        getViewport(o: { scale: number }): { width: number; height: number };
        getTextContent(): Promise<{ items: Array<{ str?: string; transform?: number[] }> }>;
      }>;
      destroy?: () => Promise<void>;
    }>;
  };
};

// pdfjs-dist 5 ist reines ESM. Unter module=commonjs wuerde tsc ein `import()`
// in `require()` verwandeln; deshalb der echte dynamische Import ueber Function.
// (pdfjs-dist 3 brachte die native Abhaengigkeit `canvas` mit — die liess den
// Desktop-Build am electron-rebuild scheitern, v0.1.821.)
const dynamischerImport = new Function("p", "return import(p)") as (p: string) => Promise<unknown>;
let pdfjs: Promise<PdfjsModul> | null = null;
function ladePdfjs(): Promise<PdfjsModul> {
  if (!pdfjs) pdfjs = dynamischerImport("pdfjs-dist/legacy/build/pdf.mjs").then((m) => m as PdfjsModul);
  return pdfjs;
}

export function istPdf(daten: Buffer): boolean {
  return daten.length > 5 && daten.subarray(0, 5).toString("latin1") === "%PDF-";
}

export async function pdfZuSeiten(daten: Buffer): Promise<CdSeite[]> {
  if (!istPdf(daten)) throw new Error("CD: Datei ist keine PDF");
  if (daten.length > CD_MAX_BYTES) throw new Error(`CD: Datei zu gross (${daten.length} Bytes)`);
  const doc = await (await ladePdfjs()).getDocument({ data: new Uint8Array(daten), useSystemFonts: true, isEvalSupported: false, disableFontFace: true }).promise;
  const seiten: CdSeite[] = [];
  try {
    for (let n = 1; n <= Math.min(doc.numPages, MAX_SEITEN); n++) {
      const page = await doc.getPage(n);
      const vp = page.getViewport({ scale: 1 });
      const tc = await page.getTextContent();
      const texte = tc.items
        .filter((i) => typeof i.str === "string" && i.str.trim() && Array.isArray(i.transform) && i.transform.length >= 6)
        .map((i) => ({ x: Math.round(i.transform![4]!), y: Math.round(vp.height - i.transform![5]!), s: i.str! }));
      seiten.push({ breite: vp.width, hoehe: vp.height, texte });
    }
  } finally {
    await doc.destroy?.().catch(() => undefined);
  }
  return seiten;
}
