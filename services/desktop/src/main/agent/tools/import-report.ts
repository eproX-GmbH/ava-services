// v0.1.390 — Import-Matching-Report (Excel).
//
// Greift den Legacy-Excel-Report wieder auf: Bei einem Bulk-Import (Dry-Run)
// liefert das Gateway/master-data ein `ImportPreview` mit
//   - matched:   eindeutig zugeordnete Firmen (direkt oder über Historie)
//   - unmatched: nicht eindeutig zugeordnete Firmen + bis zu N Kandidaten
// Wir schreiben das als mehrseitige .xlsx in den Downloads-Ordner, damit der
// Nutzer nachvollziehen kann, was gefunden wurde und was manuell geprüft
// werden muss — genau wie früher.

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { app } from "electron";
import * as XLSX from "xlsx";

export interface ImportPreviewLike {
  dryRun: true;
  providedCount: number;
  matched: Array<{
    name: string;
    location: string;
    companyId: string;
    matchingType: "direct" | "history";
  }>;
  unmatched: Array<{
    name: string;
    location: string;
    candidates: Array<{
      companyId: string;
      name: string;
      location: string;
      score: number;
    }>;
  }>;
}

function ts(now: number): string {
  // Stabiler, dateiname-sicherer Zeitstempel YYYYMMDD-HHMMSS (lokal).
  const d = new Date(now);
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

const TYPE_LABEL: Record<string, string> = {
  direct: "Direkt",
  history: "Über Historie",
};

export interface ImportReportResult {
  /** Absoluter Pfad der geschriebenen Datei. */
  path: string;
  /** Reiner Dateiname (für die Chat-Meldung). */
  filename: string;
  matchedCount: number;
  unmatchedCount: number;
}

/**
 * Baut die Report-Mappe aus einem ImportPreview und schreibt sie in den
 * Downloads-Ordner. `now` (ms) wird übergeben, damit der Aufrufer den
 * Zeitstempel kontrolliert (Testbarkeit).
 */
export async function writeImportReport(
  preview: ImportPreviewLike,
  opts: { now: number; label?: string },
): Promise<ImportReportResult> {
  const directCount = preview.matched.filter(
    (m) => m.matchingType === "direct",
  ).length;
  const historyCount = preview.matched.length - directCount;

  // Blatt 1 — Übersicht.
  const summaryRows = [
    { Kennzahl: "Übergeben", Wert: preview.providedCount },
    { Kennzahl: "Eindeutig gefunden (gesamt)", Wert: preview.matched.length },
    { Kennzahl: "  davon direkt", Wert: directCount },
    { Kennzahl: "  davon über Historie", Wert: historyCount },
    { Kennzahl: "Nicht eindeutig zugeordnet", Wert: preview.unmatched.length },
  ];

  // Blatt 2 — Gefunden.
  const matchedRows = preview.matched.map((m) => ({
    Firma: m.name,
    Ort: m.location,
    "AVA-companyId": m.companyId,
    "Treffer-Typ": TYPE_LABEL[m.matchingType] ?? m.matchingType,
  }));

  // Blatt 3 — Nicht eindeutig (Firma + bis zu 3 Kandidaten flach).
  const unmatchedRows = preview.unmatched.map((u) => {
    const row: Record<string, string | number> = {
      Firma: u.name,
      Ort: u.location,
      "Anzahl Vorschläge": u.candidates.length,
    };
    u.candidates.slice(0, 3).forEach((c, i) => {
      const n = i + 1;
      row[`Vorschlag ${n} – Name`] = c.name;
      row[`Vorschlag ${n} – Ort`] = c.location;
      row[`Vorschlag ${n} – Score`] = Math.round(c.score * 100) / 100;
      row[`Vorschlag ${n} – companyId`] = c.companyId;
    });
    return row;
  });

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(summaryRows),
    "Übersicht",
  );
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(
      matchedRows.length > 0 ? matchedRows : [{ Firma: "(keine)" }],
    ),
    "Gefunden",
  );
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(
      unmatchedRows.length > 0 ? unmatchedRows : [{ Firma: "(keine)" }],
    ),
    "Nicht eindeutig",
  );

  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;

  const safeLabel = (opts.label ?? "Import")
    .replace(/[^\p{L}\p{N}_-]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  const filename = `AVA-${safeLabel || "Import"}-Report-${ts(opts.now)}.xlsx`;
  const dir = app.getPath("downloads");
  const path = join(dir, filename);
  await writeFile(path, buf);

  return {
    path,
    filename,
    matchedCount: preview.matched.length,
    unmatchedCount: preview.unmatched.length,
  };
}
