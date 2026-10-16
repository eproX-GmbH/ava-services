// Vorabanalyse: Excel-Berichte (exceljs) — Abgleich (nach Schritt 3/4) und spaeter
// das Ergebnis. Lesbar fuer Vertrieb: Zusammenfassung, ein Blatt je Klasse, fixierte
// Kopfzeile, Filter, Farben je Status, Kandidaten in Klartext.

import ExcelJS from "exceljs";
import type { Pool } from "pg";
import { laufLesen, type Lauf } from "./store";

const FARBE = { kopf: "FF0A1F2A", treffer: "FFE3F6EE", unsicher: "FFFFF4D6", keiner: "FFFBE3E3", duplikat: "FFEDEDED" };

function kopfzeile(ws: ExcelJS.Worksheet, spalten: Array<{ header: string; key: string; width?: number }>): void {
  ws.columns = spalten.map((s) => ({ header: s.header, key: s.key, width: s.width ?? 18 }));
  const k = ws.getRow(1);
  k.font = { bold: true, color: { argb: "FFFFFFFF" } };
  k.fill = { type: "pattern", pattern: "solid", fgColor: { argb: FARBE.kopf } };
  k.alignment = { vertical: "middle" };
  ws.views = [{ state: "frozen", ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: spalten.length } };
}

function faerben(row: ExcelJS.Row, argb: string): void {
  row.eachCell({ includeEmpty: true }, (c) => { c.fill = { type: "pattern", pattern: "solid", fgColor: { argb } }; });
}

interface Zeile { zeile: number; name: string; ort: string | null; plz: string | null; strasse: string | null; land: string | null; eingabe: Record<string, unknown> | null; duplikatVon: string | null; abgleich: string | null; kandidaten: Array<{ companyId: string; name: string; ort: string | null; score: number; historie?: boolean }> | null; companyId: string | null; zuordnung: string; fehler: string | null }

export async function abgleichBericht(pool: Pool, laufId: string): Promise<{ datei: string; buffer: Buffer } | null> {
  const lauf = await laufLesen(pool, laufId);
  if (!lauf) return null;
  const r = await pool.query<Zeile>(`SELECT "zeile", "name", "ort", "plz", "strasse", "land", "eingabe", "duplikatVon", "abgleich", "kandidaten", "companyId", "zuordnung", "fehler" FROM "VorabFirma" WHERE "laufId" = $1 ORDER BY "zeile"`, [laufId]);
  const alle = r.rows;
  const wb = new ExcelJS.Workbook();
  wb.creator = "AVA";
  wb.created = new Date();

  // Blatt 1: Zusammenfassung
  const z = wb.addWorksheet("Zusammenfassung");
  z.columns = [{ width: 38 }, { width: 16 }];
  const n = (f: (x: Zeile) => boolean) => alle.filter(f).length;
  const zeilen: Array<[string, string | number]> = [
    ["Kunde", lauf.kundeName],
    ["Datei", lauf.dateiName ?? ""],
    ["Stand", new Date().toLocaleString("de-DE")],
    ["", ""],
    ["Zeilen eingelesen", alle.length],
    ["Duplikate (Name + Ort doppelt)", n((x) => x.duplikatVon != null)],
    ["Registertreffer (eindeutig)", n((x) => x.abgleich === "treffer")],
    ["Unsicher, zugeordnet (manuell oder Best Match)", n((x) => x.abgleich === "unsicher" && !!x.companyId)],
    ["Unsicher, noch offen", n((x) => x.abgleich === "unsicher" && x.zuordnung === "offen")],
    ["Ohne Registertreffer", n((x) => x.abgleich === "keiner")],
    ["Ausgeschlossen", n((x) => x.zuordnung === "ausgeschlossen")],
    ["Fehler", n((x) => !!x.fehler)],
    ["", ""],
    ["Trefferquote (Treffer + zugeordnet) in %", alle.length ? Math.round(((n((x) => x.abgleich === "treffer") + n((x) => x.abgleich === "unsicher" && !!x.companyId)) / Math.max(1, n((x) => x.duplikatVon == null))) * 1000) / 10 : 0],
  ];
  for (const [a, b] of zeilen) z.addRow([a, b]);
  z.getRow(1).font = { bold: true, size: 14 };
  z.getColumn(1).font = { bold: true };
  z.getRow(1).getCell(1).font = { bold: true, size: 14 };
  z.addRow([]);
  z.addRow(["Blätter: Treffer, Unsicher, Ohne Treffer, Duplikate, Alle. Score = Ähnlichkeit laut Suche (höher = besser); Kandidaten mit Firmen-ID."]);

  const extra = [...new Set(alle.flatMap((x) => Object.keys(x.eingabe ?? {})))].slice(0, 30);
  const basis = [
    { header: "#", key: "zeile", width: 7 }, { header: "Name", key: "name", width: 34 }, { header: "PLZ", key: "plz", width: 8 }, { header: "Ort", key: "ort", width: 20 }, { header: "Land", key: "land", width: 7 },
    { header: "Status", key: "status", width: 16 }, { header: "Zuordnung", key: "zuordnung", width: 14 }, { header: "Firmen-ID", key: "companyId", width: 26 }, { header: "Registername", key: "registername", width: 34 }, { header: "Registerort", key: "registerort", width: 18 },
    { header: "Kandidat 2", key: "k2", width: 40 }, { header: "Kandidat 3", key: "k3", width: 40 }, { header: "Hinweis", key: "hinweis", width: 30 },
  ];
  const statusText = (x: Zeile) => x.duplikatVon != null ? "Duplikat" : x.abgleich === "treffer" ? "Treffer" : x.abgleich === "unsicher" ? (x.companyId ? "Unsicher, zugeordnet" : "Unsicher, offen") : x.abgleich === "keiner" ? "Kein Treffer" : "nicht abgeglichen";
  const zuordnungText: Record<string, string> = { offen: "offen", automatisch: "eindeutig", manuell: "manuell", bestmatch: "Best Match", ausgeschlossen: "ausgeschlossen" };
  const kandText = (k: { companyId: string; name: string; ort: string | null; score: number } | undefined) => (k ? `${k.name}${k.ort ? `, ${k.ort}` : ""} (${k.companyId}, Score ${k.score})` : "");
  const datenZeile = (x: Zeile) => {
    const gewaehlt = (x.kandidaten ?? []).find((k) => k.companyId === x.companyId) ?? (x.kandidaten ?? [])[0];
    const rest = (x.kandidaten ?? []).filter((k) => k.companyId !== gewaehlt?.companyId);
    const d: Record<string, unknown> = {
      zeile: x.zeile, name: x.name, plz: x.plz ?? "", ort: x.ort ?? "", land: x.land ?? "", status: statusText(x), zuordnung: zuordnungText[x.zuordnung] ?? x.zuordnung,
      companyId: x.companyId ?? "", registername: x.companyId ? gewaehlt?.name ?? "" : (x.abgleich === "unsicher" ? `Vorschlag: ${gewaehlt?.name ?? ""}` : ""), registerort: x.companyId ? gewaehlt?.ort ?? "" : gewaehlt?.ort ?? "",
      k2: kandText(rest[0]), k3: kandText(rest[1]), hinweis: x.fehler ?? (gewaehlt?.historie ? "Treffer über früheren Firmennamen" : ""),
    };
    for (const e of extra) d[`x_${e}`] = x.eingabe?.[e] == null ? "" : String(x.eingabe[e]);
    return d;
  };
  const spalten = [...basis, ...extra.map((e) => ({ header: e, key: `x_${e}`, width: 18 }))];
  const blatt = (titel: string, filter: (x: Zeile) => boolean, farbe?: (x: Zeile) => string) => {
    const ws = wb.addWorksheet(titel);
    kopfzeile(ws, spalten);
    for (const x of alle.filter(filter)) {
      const row = ws.addRow(datenZeile(x));
      const f = farbe?.(x);
      if (f) faerben(row, f);
    }
  };
  const farbeFuer = (x: Zeile) => x.duplikatVon != null ? FARBE.duplikat : x.abgleich === "treffer" ? FARBE.treffer : x.abgleich === "unsicher" ? FARBE.unsicher : x.abgleich === "keiner" ? FARBE.keiner : "";
  blatt("Treffer", (x) => x.abgleich === "treffer" || (x.abgleich === "unsicher" && !!x.companyId), () => FARBE.treffer);
  blatt("Unsicher", (x) => x.abgleich === "unsicher" && !x.companyId, () => FARBE.unsicher);
  blatt("Ohne Treffer", (x) => x.abgleich === "keiner", () => FARBE.keiner);
  blatt("Duplikate", (x) => x.duplikatVon != null, () => FARBE.duplikat);
  blatt("Alle", () => true, farbeFuer);

  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  const datei = `ava-abgleich-${lauf.kundeName.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || laufId}.xlsx`;
  return { datei, buffer };
}

export type { Lauf };
