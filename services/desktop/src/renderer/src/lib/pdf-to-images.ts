// v0.1.302 — PDF-Seiten zu PNG-Images rendern (Scan-PDF-Fallback).
//
// Wenn pdf-parse keinen Text findet (= Scan-PDF, kein Text-Layer),
// rendern wir die ersten N Seiten per pdfjs-dist auf Canvas und liefern
// base64-PNGs zurück. Die landen direkt im pendingImages-State und
// werden vom Vision-LLM als Bilder verstanden — das macht das „OCR"
// inline.
//
// Wieso pdfjs-dist im Renderer, nicht im Main:
//   - Canvas-API ist im Browser nativ, im Node bräuchte man node-canvas
//     (native binary, Cross-Plattform-Bauschmerz).
//   - Vite bundelt pdfjs-dist sauber inkl. Worker.
//   - Renderer-Speicher reicht; ein Image-Slot ist eh begrenzt durch
//     den Vision-LLM-Cap (5/10/20 Seiten).

import * as pdfjsLib from "pdfjs-dist";

// pdfjs braucht einen Web-Worker für Parsing. Vite bundelt die JS-Datei
// als Modul, wir importieren sie als URL und setzen sie als workerSrc.
// `?url` Suffix ist Vite-Spezifisch — gibt die finale gebundelte URL
// zurück (z. B. `/assets/pdf.worker-abc123.js`).
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — Vite-spezifischer ?url-Import, kein Standard-TS
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

// Einmaliger Setup-Hook. Mehrfach-Aufruf ist no-op (pdfjs cached).
let workerConfigured = false;
function ensureWorker(): void {
  if (workerConfigured) return;
  pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl as string;
  workerConfigured = true;
}

export interface RenderedPdfPage {
  base64: string;
  mimeType: "image/png";
  filename: string;
  pageNumber: number;
}

/**
 * Rendert bis zu `maxPages` aus der PDF zu base64-PNG-Strings.
 *
 * - `scale`: Render-Auflösung. 1.5 ist ein Kompromiss zwischen
 *   Lesbarkeit (Vision-LLMs verlangen mindestens ~768px Long-Side
 *   für gute Texterkennung) und Token-Kosten. Bei `scale=1.5` ist
 *   ein A4 ca. 1240×1754 px ≈ 1.5k Tokens bei Claude.
 * - Fehler beim Einzelseiten-Render werden geschluckt; wir liefern
 *   die erfolgreich gerenderten Seiten und überspringen die kaputten.
 * - Wenn pdf-parse bereits gesagt hat „dies ist ein Scan", könnte
 *   pdfjs theoretisch denselben Fehler werfen — passiert in der
 *   Praxis aber selten, weil pdfjs deutlich toleranter parst.
 */
export async function renderPdfPagesToImages(
  bytes: Uint8Array,
  filename: string,
  opts: { maxPages: number; scale?: number } = { maxPages: 5 },
): Promise<RenderedPdfPage[]> {
  ensureWorker();
  const scale = opts.scale ?? 1.5;
  const doc = await pdfjsLib.getDocument({ data: bytes }).promise;
  const totalPages = doc.numPages;
  const renderCount = Math.min(totalPages, opts.maxPages);
  const baseName = filename.replace(/\.pdf$/i, "");
  const out: RenderedPdfPage[] = [];
  for (let pageNum = 1; pageNum <= renderCount; pageNum += 1) {
    try {
      const page = await doc.getPage(pageNum);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        console.warn(
          `[pdf-to-images] canvas-context fehlt für Seite ${pageNum}`,
        );
        continue;
      }
      await page.render({ canvasContext: ctx, viewport, canvas }).promise;
      // toDataURL gibt "data:image/png;base64,<base64>". Wir splitten
      // weil unsere Image-Pipeline base64 ohne Prefix erwartet.
      const dataUrl = canvas.toDataURL("image/png");
      const base64 = dataUrl.split(",", 2)[1] ?? "";
      if (!base64) continue;
      out.push({
        base64,
        mimeType: "image/png",
        filename: `${baseName}-Seite-${pageNum}.png`,
        pageNumber: pageNum,
      });
    } catch (err) {
      console.warn(
        `[pdf-to-images] Seite ${pageNum} konnte nicht gerendert werden:`,
        err,
      );
    }
  }
  return out;
}

/**
 * Schnelle Detection ohne Render: wie viele Seiten hat das PDF?
 * Nutzt pdfjs für die strukturelle Antwort, weil pdf-parse beim
 * Image-Fallback-Pfad nicht erneut gefragt werden soll (im
 * Renderer wäre das ein weiterer IPC-Roundtrip).
 */
export async function getPdfPageCount(bytes: Uint8Array): Promise<number> {
  ensureWorker();
  try {
    const doc = await pdfjsLib.getDocument({ data: bytes }).promise;
    return doc.numPages;
  } catch {
    return 0;
  }
}
