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
