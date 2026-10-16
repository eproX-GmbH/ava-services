// Vorabanalyse Schritt 8: Ergebnis-Exporte. CSV (Semikolon, UTF-8 mit BOM) und Excel
// (exceljs) mit mindestens Name und Ort je Zeile, damit AVA die Liste direkt importieren
// kann; dazu Registertreffer, Firmen-ID, Website, Miniprofil, Score und Begruendung.

import ExcelJS from "exceljs";
import type { Pool } from "pg";
import { laufKosten, laufLesen } from "./store";

interface Zeile {
  zeile: number; name: string; ort: string | null; plz: string | null; strasse: string | null; land: string | null; eingabe: Record<string, unknown> | null;
  duplikatVon: string | null; abgleich: string | null; kandidaten: Array<{ companyId: string; name: string; ort: string | null }> | null; companyId: string | null; zuordnung: string;
  website: string | null; websiteUrteil: { passt?: boolean; konfidenz?: number; begruendung?: string } | null;
  profil: { branche?: string; kurzbeschreibung?: string; leistungen?: string[]; zielkunden?: string; region?: string; groessenIndiz?: string; keywords?: string[] } | null;
  icpUrteil: { score?: number; passt?: boolean; begruendung?: string; ausschlussgrund?: string | null } | null; schritt: string; fehler: string | null;
}

const SPALTEN = [
  { header: "Name", key: "name", width: 34 }, { header: "Ort", key: "ort", width: 20 }, { header: "PLZ", key: "plz", width: 8 }, { header: "Straße", key: "strasse", width: 24 }, { header: "Land", key: "land", width: 6 },
  { header: "Ergebnis", key: "ergebnis", width: 18 }, { header: "ICP-Score", key: "score", width: 10 }, { header: "Begründung", key: "begruendung", width: 50 }, { header: "Ausschlussgrund", key: "ausschluss", width: 18 },
  { header: "Registertreffer", key: "register", width: 14 }, { header: "Firmen-ID", key: "companyId", width: 26 }, { header: "Registername", key: "registername", width: 32 },
  { header: "Website", key: "website", width: 34 }, { header: "Website-Konfidenz", key: "konfidenz", width: 12 }, { header: "Website-Urteil", key: "websiteUrteil", width: 40 },
  { header: "Branche", key: "branche", width: 20 }, { header: "Kurzbeschreibung", key: "kurz", width: 60 }, { header: "Leistungen", key: "leistungen", width: 40 }, { header: "Zielkunden", key: "zielkunden", width: 30 }, { header: "Region", key: "region", width: 16 }, { header: "Größe", key: "groesse", width: 18 },
  { header: "Hinweis", key: "hinweis", width: 30 }, { header: "Zeile", key: "zeile", width: 7 },
];

function ergebnisText(x: Zeile): string {
  if (x.duplikatVon != null) return "Duplikat";
  if (x.zuordnung === "ausgeschlossen") return "ausgeschlossen";
  if (x.icpUrteil) return x.icpUrteil.passt ? "AVA ready" : "passt nicht";
  if (x.websiteUrteil && !x.websiteUrteil.passt) return "keine Website";
  if (x.fehler) return "Fehler";
  return "offen";
}

function daten(x: Zeile): Record<string, unknown> {
  const reg = (x.kandidaten ?? []).find((k) => k.companyId === x.companyId);
  const p = x.profil ?? {};
  return {
    name: x.name, ort: x.ort ?? "", plz: x.plz ?? "", strasse: x.strasse ?? "", land: x.land ?? "", ergebnis: ergebnisText(x),
    score: x.icpUrteil?.score ?? "", begruendung: x.icpUrteil?.begruendung ?? "", ausschluss: x.icpUrteil?.ausschlussgrund ?? "",
    register: x.companyId ? "ja" : "nein", companyId: x.companyId ?? "", registername: reg?.name ?? "",
    website: x.website ?? "", konfidenz: x.websiteUrteil?.konfidenz ?? "", websiteUrteil: x.websiteUrteil?.begruendung ?? "",
    branche: p.branche ?? "", kurz: p.kurzbeschreibung ?? "", leistungen: (p.leistungen ?? []).join(", "), zielkunden: p.zielkunden ?? "", region: p.region ?? "", groesse: p.groessenIndiz ?? "",
    hinweis: x.fehler ?? "", zeile: x.zeile,
  };
}

async function zeilen(pool: Pool, laufId: string): Promise<Zeile[]> {
  const r = await pool.query<Zeile>(`SELECT "zeile", "name", "ort", "plz", "strasse", "land", "eingabe", "duplikatVon", "abgleich", "kandidaten", "companyId", "zuordnung", "website", "websiteUrteil", "profil", "icpUrteil", "schritt", "fehler" FROM "VorabFirma" WHERE "laufId" = $1 ORDER BY "zeile"`, [laufId]);
  return r.rows;
}

const csvZelle = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;

export async function ergebnisCsv(pool: Pool, laufId: string, nurReady: boolean): Promise<{ datei: string; text: string } | null> {
  const lauf = await laufLesen(pool, laufId);
  if (!lauf) return null;
  const alle = (await zeilen(pool, laufId)).filter((x) => (nurReady ? ergebnisText(x) === "AVA ready" : true));
  const spalten = nurReady ? SPALTEN.filter((s) => ["name", "ort", "plz", "strasse", "land", "register", "companyId", "website", "score", "begruendung", "branche"].includes(s.key)) : SPALTEN;
  const kopf = spalten.map((s) => csvZelle(s.header)).join(";");
  const body = alle.map((x) => { const d = daten(x); return spalten.map((s) => csvZelle(d[s.key])).join(";"); });
  const slug = lauf.kundeName.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || laufId;
  return { datei: `ava-${nurReady ? "ready" : "vorabanalyse"}-${slug}.csv`, text: "﻿" + [kopf, ...body].join("\r\n") + "\r\n" };
}

export async function ergebnisXlsx(pool: Pool, laufId: string): Promise<{ datei: string; buffer: Buffer } | null> {
  const lauf = await laufLesen(pool, laufId);
  if (!lauf) return null;
  const alle = await zeilen(pool, laufId);
  const kosten = await laufKosten(pool, laufId);
  const wb = new ExcelJS.Workbook();
  wb.creator = "AVA";
  const n = (t: string) => alle.filter((x) => ergebnisText(x) === t).length;
  const z = wb.addWorksheet("Zusammenfassung");
  z.columns = [{ width: 40 }, { width: 18 }];
  const rows: Array<[string, string | number]> = [
    ["Kunde", lauf.kundeName], ["Datei", lauf.dateiName ?? ""], ["Stand", new Date().toLocaleString("de-DE")], ["", ""],
    ["Zeilen eingelesen", alle.length], ["Duplikate", n("Duplikat")], ["Ausgeschlossen (manuell)", n("ausgeschlossen")],
    ["Registertreffer", alle.filter((x) => !!x.companyId).length], ["Website bestätigt", alle.filter((x) => !!x.website).length], ["Miniprofil", alle.filter((x) => !!x.profil).length],
    ["AVA ready (Score ab " + lauf.einstellungen.mindestScore + ")", n("AVA ready")], ["Passt nicht zum ICP", n("passt nicht")], ["Keine Website gefunden", n("keine Website")], ["Fehler", n("Fehler")], ["", ""],
    ["Kosten des Laufs (USD)", kosten.gesamtUsd], ["davon Modell (USD)", kosten.openaiUsd], ["davon Google-Suchen (USD)", kosten.valueserpUsd],
  ];
  for (const r of rows) z.addRow(r);
  z.getRow(1).font = { bold: true, size: 14 };
  z.getColumn(1).font = { bold: true };
  z.addRow([]);
  z.addRow(["Blatt „AVA ready“ enthält die Firmen, die zum ICP passen: Name und Ort reichen für den Import in AVA, Firmen-ID und Website beschleunigen ihn. Registertreffer = nein: Firma ohne Handelsregistereintrag (Website-Kandidat)."]);
  const extra = [...new Set(alle.flatMap((x) => Object.keys(x.eingabe ?? {})))].slice(0, 30);
  const spalten = [...SPALTEN, ...extra.map((e) => ({ header: e, key: `x_${e}`, width: 18 }))];
  const FARBE: Record<string, string> = { "AVA ready": "FFE3F6EE", "passt nicht": "FFFBE3E3", "keine Website": "FFFFF4D6", Duplikat: "FFEDEDED", ausgeschlossen: "FFEDEDED", Fehler: "FFFBE3E3", offen: "FFFFFFFF" };
  const blatt = (titel: string, filter: (x: Zeile) => boolean) => {
    const ws = wb.addWorksheet(titel);
    ws.columns = spalten.map((s) => ({ header: s.header, key: s.key, width: s.width }));
    const k = ws.getRow(1);
    k.font = { bold: true, color: { argb: "FFFFFFFF" } };
    k.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0A1F2A" } };
    ws.views = [{ state: "frozen", ySplit: 1 }];
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: spalten.length } };
    for (const x of alle.filter(filter)) {
      const d = daten(x);
      for (const e of extra) d[`x_${e}`] = x.eingabe?.[e] == null ? "" : String(x.eingabe[e]);
      const row = ws.addRow(d);
      const f = FARBE[ergebnisText(x)];
      if (f && f !== "FFFFFFFF") row.eachCell({ includeEmpty: true }, (c) => { c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: f } }; });
    }
  };
  blatt("AVA ready", (x) => ergebnisText(x) === "AVA ready");
  blatt("Passt nicht", (x) => ergebnisText(x) === "passt nicht");
  blatt("Ohne Website", (x) => ergebnisText(x) === "keine Website");
  blatt("Fehler und offen", (x) => ["Fehler", "offen"].includes(ergebnisText(x)));
  blatt("Alle", () => true);
  const slug = lauf.kundeName.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || laufId;
  return { datei: `ava-vorabanalyse-${slug}.xlsx`, buffer: Buffer.from(await wb.xlsx.writeBuffer()) };
}
