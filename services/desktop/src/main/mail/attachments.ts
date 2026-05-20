// v0.1.257 — Attachment-Pipeline.
//
// Verarbeitet einen einzelnen Mail-Anhang aus mailparser:
//   - PDFs    → pdf-parse → extractedText
//   - Text-Dateien (.txt, .md, .csv) → utf8 → extractedText
//   - Bilder (image/*) → base64 (NUR wenn visionEnabled und ≤ 5 MB)
//   - Sonst   → nur Metadaten (filename, mimeType, sizeBytes)
//
// Größenpolitik:
//   - Inline-BLOB-Limit: 10 MB (siehe store.ts INLINE_ATTACHMENT_LIMIT_BYTES)
//   - Image-base64-Limit: 5 MB (LLM-Provider akzeptieren typischerweise
//     bis 5 MB pro Bild; Anthropic 5 MB, OpenAI 20 MB. Wir nehmen den
//     restriktiveren Wert als Default. Größere Bilder werden NICHT
//     inline-base64 gespeichert; der User sieht das Bild trotzdem im
//     Triage-UI über den cachePath.)
//   - Mail-Total-Limit: 25 MB (Supervisor erzwingt das)
//
// Out of scope hier: OCR von Bildern, PDF-Bild-Extraction, DOCX/XLSX-Parse.
// Erste Iteration ist bewusst eng — Word/Excel kommen in V2.

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { app } from "electron";
import type { Attachment as ParsedAttachment } from "mailparser";
import type { MailAttachment } from "../../shared/types";

const IMAGE_INLINE_LIMIT_BYTES = 5 * 1024 * 1024;
const INLINE_LIMIT_BYTES = 10 * 1024 * 1024;
const TEXT_MIMES = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/tab-separated-values",
]);

// v0.1.260 — Office-Dokumente. Word via mammoth, Excel via xlsx (das
// bereits in deps ist für Spreadsheet-Imports im Chat). Wir extrahieren
// reinen Text — kein Formatting, keine Bilder aus Word. Für Excel
// pro Sheet: Header + erste ~200 Zeilen als CSV. Reicht für die meisten
// Mail-Anhänge (Angebote, Listen, Reports); Riesen-Workbooks landen
// dadurch deutlich knapper im LLM-Kontext.
const DOCX_MIMES = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  // Manche Mail-Clients setzen den älteren Typ:
  "application/msword",
]);
const XLSX_MIMES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
]);
const EXCEL_ROW_CAP = 200;

interface ExtractOptions {
  /** Vorläufige Message-ID. Wird vom Store überschrieben — der Aufrufer
   *  kann hier auch "pending" reinstecken. */
  messageId: string;
  /** Steuert, ob Bilder als base64 vorgehalten werden. Liegt am
   *  Modell-Catalog (capabilities.vision). */
  visionEnabled: boolean;
}

export async function extractAttachment(
  att: ParsedAttachment,
  opts: ExtractOptions,
): Promise<MailAttachment> {
  const id = randomUUID();
  const filename = att.filename ?? "anhang.bin";
  const mimeType = att.contentType ?? "application/octet-stream";
  const sizeBytes = att.size ?? att.content?.length ?? 0;
  const content = att.content;

  let extractedText: string | null = null;
  let imageBase64: string | null = null;
  let cachePath: string | null = null;

  // PDF → Text
  if (mimeType === "application/pdf" && content) {
    extractedText = await tryExtractPdfText(content);
  }
  // Word → Text
  else if (
    (DOCX_MIMES.has(mimeType) ||
      /\.docx?$/i.test(filename)) &&
    content
  ) {
    extractedText = await tryExtractDocxText(content);
  }
  // Excel → CSV-artige Text-Darstellung
  else if (
    (XLSX_MIMES.has(mimeType) ||
      /\.xlsx?$/i.test(filename)) &&
    content
  ) {
    extractedText = await tryExtractXlsxText(content);
  }
  // Text-Dateien
  else if (TEXT_MIMES.has(mimeType) && content) {
    try {
      extractedText = content.toString("utf8").slice(0, 200_000); // safety cap
    } catch {
      extractedText = null;
    }
  }
  // Bilder
  else if (mimeType.startsWith("image/") && content) {
    if (opts.visionEnabled && sizeBytes <= IMAGE_INLINE_LIMIT_BYTES) {
      imageBase64 = content.toString("base64");
    }
  }

  // Wenn Anhang > Inline-Limit, auf Filesystem cachen (für Triage-UI).
  if (sizeBytes > INLINE_LIMIT_BYTES && content) {
    cachePath = await persistToCache(id, filename, content);
  }

  return {
    id,
    messageId: opts.messageId,
    filename,
    mimeType,
    sizeBytes,
    extractedText,
    imageBase64,
    cachePath,
  };
}

/** DOCX → Plain-Text via mammoth. Behält Absatz-Struktur grob bei
 *  (mammoth's `extractRawText` ersetzt Tabs/Newlines sinnvoll). */
async function tryExtractDocxText(buf: Buffer): Promise<string | null> {
  try {
    const mod = (await import("mammoth")) as unknown as {
      extractRawText: (input: { buffer: Buffer }) => Promise<{ value: string }>;
    };
    const result = await mod.extractRawText({ buffer: buf });
    return (result.value ?? "").slice(0, 500_000);
  } catch {
    return null;
  }
}

/** XLSX → eine CSV-Tabelle pro Sheet, gekapselt mit `=== Sheet "<name>" ===`-
 *  Trennern. Pro Sheet max EXCEL_ROW_CAP Zeilen; bei mehr werden die letzten
 *  Zeilen ersetzt durch "[…N weitere Zeilen]". */
async function tryExtractXlsxText(buf: Buffer): Promise<string | null> {
  try {
    const xlsx = (await import("xlsx")) as unknown as {
      read: (data: Buffer, opts: { type: string }) => {
        SheetNames: string[];
        Sheets: Record<
          string,
          Record<string, unknown> & { "!ref"?: string }
        >;
      };
      utils: {
        sheet_to_csv: (
          ws: Record<string, unknown>,
          opts?: { FS?: string; blankrows?: boolean },
        ) => string;
      };
    };
    const wb = xlsx.read(buf, { type: "buffer" });
    const blocks: string[] = [];
    for (const name of wb.SheetNames) {
      const ws = wb.Sheets[name];
      if (!ws) continue;
      const csv = xlsx.utils.sheet_to_csv(ws, { FS: ";", blankrows: false });
      const lines = csv.split(/\r?\n/);
      const truncated =
        lines.length > EXCEL_ROW_CAP
          ? [
              ...lines.slice(0, EXCEL_ROW_CAP),
              `[…${lines.length - EXCEL_ROW_CAP} weitere Zeilen]`,
            ]
          : lines;
      blocks.push(`=== Sheet "${name}" ===\n${truncated.join("\n")}`);
    }
    if (blocks.length === 0) return null;
    return blocks.join("\n\n").slice(0, 500_000);
  } catch {
    return null;
  }
}

async function tryExtractPdfText(buf: Buffer): Promise<string | null> {
  try {
    const mod = (await import("pdf-parse")) as unknown as {
      default: (data: Buffer) => Promise<{ text: string }>;
    };
    const result = await mod.default(buf);
    return (result.text ?? "").slice(0, 500_000);
  } catch {
    // pdf-parse wirft bei verschlüsselten/kaputten PDFs. Wir tolerieren das,
    // der User sieht den Anhang ohne Text-Extract.
    return null;
  }
}

async function persistToCache(
  id: string,
  filename: string,
  content: Buffer,
): Promise<string> {
  const dir = join(app.getPath("userData"), "mail-cache");
  await fs.mkdir(dir, { recursive: true });
  // Filename behalten (für Render im Triage), aber UUID-prefixen damit
  // Kollisionen ausgeschlossen sind.
  const safeName = filename.replace(/[^\w.\-]+/g, "_").slice(0, 80);
  const target = join(dir, `${id}-${safeName}`);
  await fs.writeFile(target, content);
  return target;
}

export { IMAGE_INLINE_LIMIT_BYTES, INLINE_LIMIT_BYTES };
