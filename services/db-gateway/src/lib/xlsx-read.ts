// Minimal OOXML reader — just enough to detect CRM-id columns in
// the user's xlsx and extract per-row external ids.
//
// Why hand-roll rather than pull in `xlsx` / `exceljs`: same rationale
// as xlsx-mini (write-side) — those packages are 1.5-3MB each + heavy
// transitive trees, and we only need to read header row + a single
// CRM-id cell per row. We support the two storage shapes master-data
// emits and most exporters produce:
//
//   - inline strings:    <c r="A1" t="inlineStr"><is><t>...</t></is></c>
//   - sharedStrings ref: <c r="A1" t="s"><v>INDEX</v></c>
//   - plain numbers:     <c r="A1"><v>123</v></c>
//
// Anything fancier (styles, formula results, dates) we don't care
// about — for our purposes CRM ids are strings or integers.

import { unzipSync, strFromU8 } from "fflate";
import { logger } from "./logger";

export interface ParsedSheet {
  /** Header row values, in column order. */
  headers: string[];
  /** Data rows, each indexed by column letter→string value. */
  rows: Array<Record<string, string>>;
}

const CELL_RE =
  /<c\s+([^>]*?)\/>|<c\s+([^>]*?)>([\s\S]*?)<\/c>/g;
const REF_RE = /r="([A-Z]+)\d+"/;
const TYPE_RE = /t="([a-zA-Z]+)"/;
const INLINE_T_RE = /<t[^>]*>([\s\S]*?)<\/t>/;
const V_RE = /<v>([\s\S]*?)<\/v>/;

function xmlDecode(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function readSharedStrings(xml: string): string[] {
  const out: string[] = [];
  const re = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    // Concatenate all <t>…</t> inside this <si>; <r><t>… runs are joined.
    const inner = m[1]!;
    const tre = /<t[^>]*>([\s\S]*?)<\/t>/g;
    let tm: RegExpExecArray | null;
    let buf = "";
    while ((tm = tre.exec(inner))) buf += xmlDecode(tm[1]!);
    out.push(buf);
  }
  return out;
}

/**
 * Read the first sheet's header row + data rows from an xlsx byte
 * buffer. Returns `null` on any parse failure — callers should treat
 * detection-time failures as "no CRM headers found" rather than
 * aborting the import.
 */
export function parseXlsxFirstSheet(bytes: Uint8Array): ParsedSheet | null {
  let zip: Record<string, Uint8Array>;
  try {
    zip = unzipSync(bytes);
  } catch (err) {
    logger.warn({ err }, "xlsx-read: unzip failed");
    return null;
  }

  // Find the first worksheet. Standard layout puts sheet1 at
  // xl/worksheets/sheet1.xml; fall back to any worksheet entry.
  const sheetKey =
    Object.keys(zip).find((k) => /^xl\/worksheets\/sheet1\.xml$/i.test(k)) ??
    Object.keys(zip).find((k) =>
      /^xl\/worksheets\/sheet\d+\.xml$/i.test(k),
    );
  if (!sheetKey) return null;
  const sheetXml = strFromU8(zip[sheetKey]!);

  const ssKey = Object.keys(zip).find((k) =>
    /^xl\/sharedStrings\.xml$/i.test(k),
  );
  const shared = ssKey ? readSharedStrings(strFromU8(zip[ssKey]!)) : [];

  // Parse <row>...</row> blocks in order.
  const rows: Array<Record<string, string>> = [];
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let rm: RegExpExecArray | null;
  while ((rm = rowRe.exec(sheetXml))) {
    const inner = rm[1]!;
    const cells: Record<string, string> = {};
    let cm: RegExpExecArray | null;
    CELL_RE.lastIndex = 0;
    while ((cm = CELL_RE.exec(inner))) {
      const attrs = cm[1] ?? cm[2] ?? "";
      const body = cm[3] ?? "";
      const refMatch = REF_RE.exec(attrs);
      if (!refMatch) continue;
      const col = refMatch[1]!;
      const typeMatch = TYPE_RE.exec(attrs);
      const type = typeMatch?.[1] ?? "";
      let value = "";
      if (type === "inlineStr") {
        const im = INLINE_T_RE.exec(body);
        if (im) value = xmlDecode(im[1]!);
      } else if (type === "s") {
        const vm = V_RE.exec(body);
        if (vm) {
          const idx = Number(vm[1]);
          if (Number.isFinite(idx) && idx >= 0 && idx < shared.length) {
            value = shared[idx]!;
          }
        }
      } else if (type === "str" || type === "b" || type === "" || type === "n") {
        const vm = V_RE.exec(body);
        if (vm) value = xmlDecode(vm[1]!);
      } else {
        const vm = V_RE.exec(body);
        if (vm) value = xmlDecode(vm[1]!);
      }
      cells[col] = value.trim();
    }
    rows.push(cells);
  }

  if (rows.length === 0) return null;
  const headerRow = rows[0]!;
  const headers: string[] = [];
  // Build headers as a positional list by sorting column letters.
  const cols = Object.keys(headerRow).sort((a, b) => {
    if (a.length !== b.length) return a.length - b.length;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  for (const c of cols) headers.push(headerRow[c]!);

  // Index columns→headerIndex so callers can pull by name.
  return {
    headers,
    rows: rows.slice(1),
  };
}

// =============================================================================
// CRM header detection
// =============================================================================

const CRM_HEADER_RULES: Array<{
  pattern: RegExp;
  type: "HUBSPOT" | "SALESFORCE" | "DYNAMICS";
}> = [
  {
    pattern:
      /^(hubspot[_ ]?id|hs[_ ]?object[_ ]?id|hubspot[_ ]?company[_ ]?id)$/i,
    type: "HUBSPOT",
  },
  {
    pattern: /^(salesforce[_ ]?id|sfdc[_ ]?id|sf[_ ]?id)$/i,
    type: "SALESFORCE",
  },
  {
    pattern:
      /^(dynamics[_ ]?id|msd[_ ]?id|dataverse[_ ]?id|d365[_ ]?id)$/i,
    type: "DYNAMICS",
  },
];

export interface CrmColumnHit {
  /** Column letter ('A', 'B', …) in the sheet. */
  column: string;
  /** Header text as it appears in row 1. */
  header: string;
  crmType: "HUBSPOT" | "SALESFORCE" | "DYNAMICS";
}

/**
 * Scan the parsed sheet's header row for CRM-id columns. Returns one
 * entry per typed column. Multiple typed columns on the same sheet
 * (HubSpot + Salesforce) yield multiple entries.
 */
export function detectCrmColumns(sheet: ParsedSheet): CrmColumnHit[] {
  if (!sheet) return [];
  // We need column letters for the matched columns, not header indices.
  // Rebuild the header row with letter keys so the caller can look up
  // per-row values.
  const headerCells = sheet.headers;
  const hits: CrmColumnHit[] = [];
  for (let i = 0; i < headerCells.length; i++) {
    const header = (headerCells[i] ?? "").trim();
    if (!header) continue;
    for (const rule of CRM_HEADER_RULES) {
      if (rule.pattern.test(header)) {
        hits.push({
          column: colLetter(i),
          header,
          crmType: rule.type,
        });
        break;
      }
    }
  }
  return hits;
}

/** A1-style column letter for a 0-based index. */
function colLetter(idx: number): string {
  let n = idx;
  let out = "";
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

/**
 * Build a per-row map of {name, city, crmLinks[]} suitable for
 * matching back against master-data's preview/import response.
 *
 * `nameHeaders` / `cityHeaders` are the CSV/list the caller passed to
 * master-data; we look up the corresponding column letters in the
 * header row. Multiple name columns get joined with a single space.
 */
export interface RowMapping {
  /** The composite name string master-data sees (joined name columns). */
  name: string;
  /** Composite location string (city columns joined with space). */
  location: string;
  crmLinks: Array<{
    crmType: "HUBSPOT" | "SALESFORCE" | "DYNAMICS";
    externalId: string;
  }>;
}

export function buildRowMappings(
  sheet: ParsedSheet,
  nameHeaders: string[],
  cityHeaders: string[],
): RowMapping[] {
  if (!sheet) return [];
  const letterFor = (header: string): string | null => {
    for (let i = 0; i < sheet.headers.length; i++) {
      if (sheet.headers[i]?.trim().toLowerCase() === header.trim().toLowerCase()) {
        return colLetter(i);
      }
    }
    return null;
  };
  const nameLetters = nameHeaders
    .map((h) => letterFor(h))
    .filter((x): x is string => !!x);
  const cityLetters = cityHeaders
    .map((h) => letterFor(h))
    .filter((x): x is string => !!x);
  const crmHits = detectCrmColumns(sheet);

  return sheet.rows.map((row) => {
    const name = nameLetters
      .map((l) => row[l] ?? "")
      .filter(Boolean)
      .join(" ")
      .trim();
    const location = cityLetters
      .map((l) => row[l] ?? "")
      .filter(Boolean)
      .join(" ")
      .trim();
    const crmLinks = crmHits
      .map((hit) => ({
        crmType: hit.crmType,
        externalId: (row[hit.column] ?? "").trim(),
      }))
      .filter((l) => l.externalId.length > 0);
    return { name, location, crmLinks };
  });
}
