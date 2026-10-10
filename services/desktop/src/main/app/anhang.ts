// Anhänge aus der AVA-App (docs/PLAN_APP_PWA.md §3.2, P3): Datei aufbereiten
// (Tabelle, PDF, Word, Text), im AttachmentStore ablegen und den Marker-Block
// erzeugen, den der Desktop-Chat vor die Nachricht setzt
// (renderer/src/lib/attachment.ts renderAttachmentForPrompt, gleiche Form).

import * as XLSX from "xlsx";
import type { AttachmentStore } from "../agent/attachment-store";
import { typAusDateiname } from "../agent/attachment-store";
import { textAusDatei } from "../agent/datei-text";

export const ANHANG_MAX_BYTES = 25 * 1024 * 1024;
const MUSTERZEILEN = 5;

interface Blatt {
  name: string;
  headers: string[];
  sampleRows: string[][];
  totalRows: number;
}

const groesse = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const kuerzen = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const zitat = (s: string) => `"${s.replace(/"/g, '""')}"`;

function tabelle(bytes: Uint8Array): Blatt[] {
  const wb = XLSX.read(bytes, { type: "array" });
  return wb.SheetNames.map((name) => {
    const ws = wb.Sheets[name];
    if (!ws) return { name, headers: [], sampleRows: [], totalRows: 0 };
    const aoa = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, defval: "", blankrows: false, raw: false });
    const headers = (aoa[0] ?? []).map((c) => String(c ?? "").trim());
    const daten = aoa.slice(1);
    return {
      name,
      headers,
      sampleRows: daten.slice(0, MUSTERZEILEN).map((r) => Array.from({ length: headers.length }, (_, i) => String(r[i] ?? "").trim())),
      totalRows: daten.length,
    };
  });
}

export interface AufbereiteterAnhang {
  id: string;
  filename: string;
  sizeBytes: number;
  typ: string;
  marker: string;
}

export async function anhangAufbereiten(
  store: AttachmentStore,
  input: { filename: string; bytes: Uint8Array; conversationId?: string },
): Promise<AufbereiteterAnhang> {
  if (input.bytes.byteLength > ANHANG_MAX_BYTES) throw new Error(`Datei zu groß (${groesse(input.bytes.byteLength)}, höchstens 25 MB).`);
  const typ = typAusDateiname(input.filename);
  let blaetter: Blatt[] = [];
  let seiten: string[] | undefined;
  let numPages: number | undefined;
  if (typ === "tabelle") {
    blaetter = tabelle(input.bytes);
  } else if (typ === "pdf" || typ === "docx") {
    const t = await textAusDatei({ filename: input.filename, bytes: input.bytes });
    seiten = t.seiten;
    numPages = t.numPages;
  } else if (typ === "text") {
    seiten = [new TextDecoder("utf-8").decode(input.bytes)];
  }
  const staged = store.stage({
    filename: input.filename,
    bytes: input.bytes,
    sheets: blaetter.map((b) => ({ name: b.name, headers: b.headers, totalRows: b.totalRows })),
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    ...(seiten ? { seiten } : {}),
    typ,
  });

  const z: string[] = [`[attachment: ${input.filename}, id: ${staged.id}]`];
  if (typ !== "tabelle") {
    const umfang = numPages ? ` · ${numPages} Seite${numPages === 1 ? "" : "n"}` : "";
    z.push(`Typ: ${typ}${umfang} · ${groesse(staged.sizeBytes)}`);
    z.push(staged.kurzansicht ? `Kurzansicht: ${staged.kurzansicht}` : "Kein Text extrahierbar; nur als Anhang weiterreichbar.");
  } else {
    for (const b of blaetter) {
      z.push("", `Sheet "${b.name}" (${b.totalRows} data row${b.totalRows === 1 ? "" : "s"}):`);
      if (b.headers.length === 0) {
        z.push("(empty sheet)");
        continue;
      }
      z.push(`Columns: ${b.headers.map(zitat).join(", ")}`);
      if (b.sampleRows.length === 0) {
        z.push("(no data rows)");
        continue;
      }
      z.push(`Sample (first ${b.sampleRows.length} of ${b.totalRows}):`);
      b.sampleRows.forEach((r, i) => z.push(`${i + 1}. ${r.map((c) => zitat(kuerzen(c, 80))).join(", ")}`));
    }
  }
  return { id: staged.id, filename: input.filename, sizeBytes: staged.sizeBytes, typ, marker: z.join("\n") };
}
