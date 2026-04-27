import { zipSync, strToU8 } from "fflate";

// Minimal xlsx (OOXML) encoder.
//
// Why hand-roll: the gateway only needs to produce a *single-row* sheet so
// the existing `/api/v1/data-care` upstream can ingest one company without
// changing its contract. Pulling in `xlsx` (sheetjs, ~1.5MB) or `exceljs`
// (~3MB + heavy transitive tree) for two cells is overkill — `fflate`
// gives us deflate + zip-archive in 7KB and we generate the OOXML parts
// by hand.
//
// Compatibility:
//   - Inline strings (`<is><t>…</t></is>`) instead of a sharedStrings part.
//     Saves a file and a relationship; every Excel-grade parser we know
//     of (incl. master-data's parser) accepts inline strings.
//   - No styles part. The header row is plain text; the consumer doesn't
//     read formatting.
//   - Sheet dimension is computed (`A1:<lastCol><lastRow>`); some parsers
//     ignore it but others (Apache POI strict mode) treat its absence as
//     an error.
//
// File layout produced (5 entries):
//   [Content_Types].xml
//   _rels/.rels
//   xl/workbook.xml
//   xl/_rels/workbook.xml.rels
//   xl/worksheets/sheet1.xml
//
// If/when we need merged styles or multi-sheet output, swap to a real
// library. This module is intentionally write-only and single-purpose.

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

/** XML-escape just the five reserved chars; sufficient for cell text. */
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** A1-style column letter for a 0-based index (0→A, 25→Z, 26→AA, …). */
function colLetter(idx: number): string {
  let n = idx;
  let out = "";
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

export interface BuildXlsxArgs {
  /** First row — column headers. `companyNameIdentifiers` / `city` query
   *  params on the upstream call must match these exactly. */
  headers: string[];
  /** Subsequent rows. Each row is an array aligned with `headers`. Missing
   *  trailing cells are written as empty strings. */
  rows: string[][];
}

/**
 * Builds a single-sheet xlsx file as a Uint8Array. The sheet is named
 * "Sheet1" and contains `[headers, ...rows]`. All cells are stored as
 * inline strings — master-data's parser already treats every cell as a
 * label, so numeric typing wouldn't help anything downstream.
 */
export function buildXlsx(args: BuildXlsxArgs): Uint8Array {
  const { headers, rows } = args;
  if (headers.length === 0) {
    throw new Error("buildXlsx: headers must not be empty");
  }

  // ---- xl/worksheets/sheet1.xml -------------------------------------------
  const allRows = [headers, ...rows];
  const lastCol = colLetter(headers.length - 1);
  const lastRow = allRows.length;
  const dimension = `A1:${lastCol}${lastRow}`;

  const rowXml = allRows
    .map((cells, rIdx) => {
      const r = rIdx + 1;
      const padded = cells.concat(
        Array(Math.max(0, headers.length - cells.length)).fill(""),
      );
      const cellXml = padded
        .map((value, cIdx) => {
          const ref = `${colLetter(cIdx)}${r}`;
          // `t="inlineStr"` = string literal embedded in the cell rather
          // than indexed via sharedStrings.xml.
          return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(
            value ?? "",
          )}</t></is></c>`;
        })
        .join("");
      return `<row r="${r}">${cellXml}</row>`;
    })
    .join("");

  const sheetXml =
    XML_DECL +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<dimension ref="${dimension}"/>` +
    `<sheetData>${rowXml}</sheetData>` +
    `</worksheet>`;

  // ---- xl/workbook.xml ----------------------------------------------------
  // r:id="rId1" links to xl/worksheets/sheet1.xml via xl/_rels/workbook.xml.rels.
  const workbookXml =
    XML_DECL +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"` +
    ` xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>` +
    `</workbook>`;

  // ---- xl/_rels/workbook.xml.rels -----------------------------------------
  const workbookRelsXml =
    XML_DECL +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1"` +
    ` Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"` +
    ` Target="worksheets/sheet1.xml"/>` +
    `</Relationships>`;

  // ---- _rels/.rels --------------------------------------------------------
  const rootRelsXml =
    XML_DECL +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1"` +
    ` Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"` +
    ` Target="xl/workbook.xml"/>` +
    `</Relationships>`;

  // ---- [Content_Types].xml ------------------------------------------------
  // Every part referenced above must be declared here, plus the default
  // extensions xlsx readers expect to be present.
  const contentTypesXml =
    XML_DECL +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml"` +
    ` ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    `<Override PartName="/xl/worksheets/sheet1.xml"` +
    ` ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
    `</Types>`;

  // fflate's zipSync wants a tree of {path: Uint8Array}. We bundle level 6
  // deflate (its default) — payload is tiny so picking any other level is
  // a wash on speed/size.
  const archive = zipSync(
    {
      "[Content_Types].xml": strToU8(contentTypesXml),
      "_rels/.rels": strToU8(rootRelsXml),
      "xl/workbook.xml": strToU8(workbookXml),
      "xl/_rels/workbook.xml.rels": strToU8(workbookRelsXml),
      "xl/worksheets/sheet1.xml": strToU8(sheetXml),
    },
    { level: 6 },
  );
  return archive;
}
