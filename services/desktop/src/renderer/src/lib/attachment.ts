import * as XLSX from "xlsx";

// Spreadsheet attachment parsing (Phase 8.k10i — "Excel in chat", Scope A).
//
// Renderer-only: we parse the file client-side with SheetJS, extract a
// compact metadata payload (headers + a handful of sample rows + total
// row count), and stitch it into the user's prompt at send time. The
// agent never sees the raw bytes — by design. If it later needs the
// rest, the path is to add a `read_attachment` tool (Scope B), but for
// now most lead-style sheets fit comfortably in headers+samples.
//
// Why renderer-side parsing rather than IPC-to-main:
//   - Privacy: the user can preview what's being sent before pressing
//     Send (the chip can be removed).
//   - Latency: no main↔renderer round-trip on every drop.
//   - Simplicity: SheetJS works in browsers without polyfills.
//
// Supported formats: .xlsx, .xls, .csv. SheetJS handles all three with
// the same `read()` entry point — type detection is automatic.

export interface SheetSummary {
  /** Sheet name as it appears in the workbook. */
  name: string;
  /** Column headers (first row). Empty cells become "" — preserve
   *  positional alignment with sampleRows. */
  headers: string[];
  /** Up to ATTACHMENT_SAMPLE_ROWS data rows (after the header). */
  sampleRows: string[][];
  /** Total data-row count (excluding the header). */
  totalRows: number;
}

export interface SpreadsheetAttachment {
  /** Stable id for this attachment in the renderer's UI state. */
  id: string;
  /** Original filename, used for the chip + the agent's prompt. */
  filename: string;
  /** Bytes on disk — purely for the chip's secondary line. */
  sizeBytes: number;
  /**
   * Original file bytes — kept around so we can ship them to main on
   * send (`window.api.agent.stageAttachment`). Phase 8.e (Excel-in-chat
   * Scope C) uses these for the actual import upload; without them the
   * agent could only see headers + samples and would fall back to
   * row-by-row `company_search` which is exactly what we're avoiding.
   * Cleared on a successful send so removed chips don't pin RAM.
   */
  bytes: Uint8Array;
  /** One entry per worksheet. Workbooks frequently have one sheet,
   *  but lead spreadsheets sometimes have e.g. "Companies" + "Notes". */
  sheets: SheetSummary[];
  /** Optional parse-warning surfaced as a chip subtext (e.g. truncation). */
  warning?: string;
  /**
   * Set by `Chat.tsx` after `window.api.agent.stageAttachment` returns —
   * the main-process id we weave into the user prompt so the agent has
   * a stable handle for the `import_excel` tool. Undefined until staged.
   */
  stagedId?: string;
  /**
   * User-supplied label for the resulting transaction (Phase 8.f5
   * inline-name addon). Captured by the form field next to the chip
   * in the composer; woven into the `[attachment: …, name: "…"]`
   * header so the agent can read it back and pass it to `import_excel`
   * without an extra `ask_user_text` round-trip. Trimmed; empty
   * string is treated as "not provided" (importer falls back to
   * filename).
   */
  transactionName?: string;
}

/** Headers + samples we lift from each sheet. Keep small so the prompt
 *  stays under typical context windows. */
const ATTACHMENT_SAMPLE_ROWS = 5;

/** Hard cap on filename → bigger files probably aren't lead lists. */
export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024; // 25 MB

/** Recognised extensions. We match by extension first, then fall back
 *  to letting SheetJS try (it'll throw on garbage). */
const SUPPORTED_EXT = [".xlsx", ".xls", ".csv", ".tsv"] as const;

export function isSupportedAttachment(file: File): boolean {
  const name = file.name.toLowerCase();
  return SUPPORTED_EXT.some((ext) => name.endsWith(ext));
}

export async function parseAttachment(
  file: File,
): Promise<SpreadsheetAttachment> {
  if (file.size > ATTACHMENT_MAX_BYTES) {
    throw new Error(
      `File too large (${formatBytes(file.size)}). Max ${formatBytes(ATTACHMENT_MAX_BYTES)}.`,
    );
  }
  const buf = await file.arrayBuffer();
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(buf, { type: "array" });
  } catch (err) {
    throw new Error(
      `Couldn't parse "${file.name}": ${err instanceof Error ? err.message : "unknown format"}.`,
    );
  }

  const sheets: SheetSummary[] = workbook.SheetNames.map((name) => {
    const ws = workbook.Sheets[name];
    if (!ws) return { name, headers: [], sampleRows: [], totalRows: 0 };
    // header:1 → array-of-arrays, defval:"" → preserve positional shape
    // even when cells are empty (otherwise the sample rows shrink to
    // their last non-empty index, breaking column alignment).
    const aoa = XLSX.utils.sheet_to_json<string[]>(ws, {
      header: 1,
      defval: "",
      blankrows: false,
      raw: false, // formatted strings — dates render as "2024-01-15", not 45306.
    });
    const headerRow = (aoa[0] ?? []).map((c) => String(c ?? "").trim());
    const dataRows = aoa.slice(1);
    const sampleRows = dataRows
      .slice(0, ATTACHMENT_SAMPLE_ROWS)
      .map((row) =>
        // Pad/truncate to header width so column alignment is stable.
        Array.from({ length: headerRow.length }, (_, i) =>
          String(row[i] ?? "").trim(),
        ),
      );
    return {
      name,
      headers: headerRow,
      sampleRows,
      totalRows: dataRows.length,
    };
  });

  return {
    id: makeAttachmentId(),
    filename: file.name,
    sizeBytes: file.size,
    bytes: new Uint8Array(buf),
    sheets,
  };
}

/**
 * Render an attachment into a markdown block we prepend to the user's
 * prompt at send time. The shape is deliberate:
 *
 *   - A titled fenced block so the model sees clear boundaries.
 *   - Headers as a CSV-like row (small models follow this better than
 *     pretty pipes for column-heavy sheets).
 *   - Samples as numbered rows.
 *   - Explicit totalRows so the agent doesn't assume the samples ARE the data.
 *
 * Multiple attachments concatenate. We cap each cell at 80 chars to
 * keep one weird "long description" column from inflating the prompt.
 */
export function renderAttachmentForPrompt(
  attachment: SpreadsheetAttachment,
): string {
  const lines: string[] = [];
  // Weave the staged id into the header so the agent can pass it to
  // `import_excel`. Falls back gracefully if a caller renders before
  // staging (the `id:` segment just gets omitted). The optional
  // `name:` segment carries the user's transaction-name from the
  // composer field — read by the agent in lieu of a follow-up
  // `ask_user_text` call (8.f5 inline-name addon).
  const idSegment = attachment.stagedId ? `, id: ${attachment.stagedId}` : "";
  const trimmedName = (attachment.transactionName ?? "").trim();
  const nameSegment = trimmedName
    ? `, name: ${JSON.stringify(trimmedName)}`
    : "";
  lines.push(
    `[attachment: ${attachment.filename}${idSegment}${nameSegment}]`,
  );
  for (const sheet of attachment.sheets) {
    lines.push("");
    lines.push(`Sheet "${sheet.name}" (${sheet.totalRows} data row${sheet.totalRows === 1 ? "" : "s"}):`);
    if (sheet.headers.length === 0) {
      lines.push("(empty sheet)");
      continue;
    }
    lines.push(`Columns: ${sheet.headers.map(quote).join(", ")}`);
    if (sheet.sampleRows.length === 0) {
      lines.push("(no data rows)");
      continue;
    }
    lines.push(
      `Sample (first ${sheet.sampleRows.length} of ${sheet.totalRows}):`,
    );
    sheet.sampleRows.forEach((row, i) => {
      const cells = row.map((c) => truncate(c, 80)).map(quote).join(", ");
      lines.push(`${i + 1}. ${cells}`);
    });
  }
  return lines.join("\n");
}

/** Compose the final outgoing text: every attachment block, then the user's typed message. */
export function composePromptWithAttachments(
  userText: string,
  attachments: SpreadsheetAttachment[],
): string {
  if (attachments.length === 0) return userText;
  const blocks = attachments.map(renderAttachmentForPrompt);
  return [...blocks, "", userText].join("\n");
}

// ---- Helpers ---------------------------------------------------------------

function makeAttachmentId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `att-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

function quote(s: string): string {
  // Light quoting so the model can see the column boundaries even when
  // a header itself contains commas. Not full CSV quoting — strings
  // with embedded quotes get backslash-escaped which is good enough
  // for prompt context.
  return `"${s.replace(/"/g, '\\"')}"`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
