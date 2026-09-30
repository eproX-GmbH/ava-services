// Datei-Werkzeuge (docs/PLAN_CHAT_DATEIEN_KONTEXT.md, D2, 2026-09-30).
//
// Das Modell bekommt vom Upload nur Marker + Kurzansicht. Braucht es den
// Inhalt, liest es gezielt: erst suchen, dann den Treffer lesen. Alles
// deterministisch, keine KI-Kosten. Grenzen je Antwort, damit ein
// einzelner Aufruf den Kontext nicht sprengt.

import * as yup from "yup";
import { defineTool } from "../define-tool";
import type { Tool } from "../types";
import type { AttachmentStore, StagedAttachment } from "../attachment-store";

const MAX_LESEN = 12_000;
const MAX_TREFFER = 20;

function seitenVon(d: StagedAttachment): string[] {
  if (d.seiten && d.seiten.length > 0) return d.seiten;
  if (d.typ === "tabelle") {
    return d.sheets.map((s) => `Tabellenblatt "${s.name}": ${s.totalRows} Zeilen, Spalten: ${s.headers.join(", ")}`);
  }
  return [];
}

function info(d: StagedAttachment) {
  const seiten = seitenVon(d);
  return {
    id: d.id,
    name: d.filename,
    typ: d.typ,
    groesseBytes: d.sizeBytes,
    seiten: seiten.length,
    zeichen: seiten.reduce((n, s) => n + s.length, 0),
    kurzansicht: d.kurzansicht ?? null,
    ...(d.typ === "tabelle" ? { tabellenblaetter: d.sheets } : {}),
    ...(d.typ === "bild" || d.typ === "sonstige" ? { hinweis: "Kein Text extrahierbar. Zum Weiterreichen (Mail, Import) reicht das Handle." } : {}),
  };
}

export function buildDateiTools(deps: { attachments: AttachmentStore }): Tool[] {
  const aufloesen = (angabe: string, convId: string | undefined) => deps.attachments.aufloesen(convId, angabe);

  const dateiInfo = defineTool({
    name: "datei_info",
    category: "dateien anhang upload pdf",
    description:
      "Metadaten und Kurzansicht einer im Chat hochgeladenen Datei (Handle att-…, Dateiname oder eindeutiger Namensteil). Ohne `datei` listet es alle Dateien dieser Unterhaltung. " +
      "Lies eine Datei nur, wenn die Aufgabe ihren Inhalt braucht. Zum Weiterreichen (Mail-Anhang, Import) reicht das Handle.",
    parameters: { type: "object", properties: { datei: { type: "string", description: "Handle, Dateiname oder Namensteil; leer = alle Dateien." } } },
    schema: yup.object({ datei: yup.string().trim().optional() }),
    run: async (args, ctx) => {
      if (!args.datei) {
        const liste = deps.attachments.listeFuer(ctx.conversationId);
        return { dateien: liste.map(info), anzahl: liste.length };
      }
      const r = aufloesen(args.datei, ctx.conversationId);
      if ("fehler" in r) return { error: r.fehler, kandidaten: r.kandidaten };
      return info(r.datei);
    },
    preview: (r) => ("dateien" in (r as object) ? `${(r as { anzahl: number }).anzahl} Dateien` : `Datei-Info ${(r as { name?: string }).name ?? ""}`),
  });

  const dateiLesen = defineTool({
    name: "datei_lesen",
    category: "dateien anhang upload pdf",
    description:
      "Liest einen Ausschnitt einer hochgeladenen Datei: Seitenbereich (`seiten: \"3-5\"` oder `\"7\"`) oder Zeichenbereich innerhalb des Gesamttexts (`von`/`bis`). Höchstens 12.000 Zeichen je Aufruf; die Antwort sagt, wo es weitergeht. " +
      "Nutze vorher `datei_suchen`, um die richtige Stelle zu finden, statt eine ganze Datei seitenweise zu lesen.",
    parameters: {
      type: "object",
      properties: {
        datei: { type: "string" },
        seiten: { type: "string", description: "z. B. \"1-3\" oder \"7\" (1-basiert)" },
        von: { type: "integer", description: "Zeichenposition im Gesamttext (0-basiert)" },
        bis: { type: "integer" },
      },
      required: ["datei"],
    },
    schema: yup.object({
      datei: yup.string().trim().min(1).required(),
      seiten: yup.string().trim().matches(/^\d+(-\d+)?$/).optional(),
      von: yup.number().integer().min(0).optional(),
      bis: yup.number().integer().min(1).optional(),
    }),
    run: async (args, ctx) => {
      const r = aufloesen(args.datei, ctx.conversationId);
      if ("fehler" in r) return { error: r.fehler, kandidaten: r.kandidaten };
      const seiten = seitenVon(r.datei);
      if (seiten.length === 0) return { error: `"${r.datei.filename}" enthält keinen lesbaren Text (Typ ${r.datei.typ}).` };
      if (args.seiten) {
        const [aS, bS] = args.seiten.split("-");
        const a = Math.max(1, Number(aS)); const b = Math.min(seiten.length, Number(bS ?? aS));
        if (a > seiten.length) return { error: `Die Datei hat nur ${seiten.length} Seiten.` };
        let text = ""; let bisSeite = a - 1;
        for (let i = a - 1; i < b; i++) {
          const block = `--- Seite ${i + 1} ---\n${seiten[i]}\n`;
          if (text.length + block.length > MAX_LESEN && text.length > 0) break;
          text += block.slice(0, MAX_LESEN - text.length); bisSeite = i + 1;
          if (text.length >= MAX_LESEN) break;
        }
        const weiter = bisSeite < b ? `Gekürzt. Weiter mit seiten: "${bisSeite + 1}-${b}".` : bisSeite < seiten.length ? `Weiter mit seiten: "${bisSeite + 1}".` : "Ende der Datei.";
        return { name: r.datei.filename, seiten: `${a}-${bisSeite}`, seitenGesamt: seiten.length, text, weiter };
      }
      const gesamt = seiten.join("\n\n");
      const von = args.von ?? 0;
      const bis = Math.min(gesamt.length, args.bis ?? von + MAX_LESEN, von + MAX_LESEN);
      if (von >= gesamt.length) return { error: `Die Datei hat nur ${gesamt.length} Zeichen.` };
      return { name: r.datei.filename, von, bis, zeichenGesamt: gesamt.length, text: gesamt.slice(von, bis), weiter: bis < gesamt.length ? `Weiter mit von: ${bis}.` : "Ende der Datei." };
    },
    preview: (r) => ("error" in (r as object) ? `Fehler: ${(r as { error: string }).error}` : `${(r as { name: string }).name} gelesen`),
  });

  const dateiSuchen = defineTool({
    name: "datei_suchen",
    category: "dateien anhang upload pdf",
    description:
      "Sucht in einer hochgeladenen Datei nach einem Begriff oder regulären Ausdruck (ohne Groß-/Kleinschreibung) und liefert bis zu 20 Fundstellen mit Seite und Umfeld. Danach die Stelle mit `datei_lesen` lesen.",
    parameters: {
      type: "object",
      properties: {
        datei: { type: "string" },
        begriff: { type: "string", description: "Suchbegriff oder Regex" },
        umfeld: { type: "integer", description: "Zeichen vor und nach dem Treffer (Standard 200)" },
      },
      required: ["datei", "begriff"],
    },
    schema: yup.object({ datei: yup.string().trim().min(1).required(), begriff: yup.string().min(1).max(200).required(), umfeld: yup.number().integer().min(20).max(1000).optional() }),
    run: async (args, ctx) => {
      const r = aufloesen(args.datei, ctx.conversationId);
      if ("fehler" in r) return { error: r.fehler, kandidaten: r.kandidaten };
      const seiten = seitenVon(r.datei);
      if (seiten.length === 0) return { error: `"${r.datei.filename}" enthält keinen lesbaren Text (Typ ${r.datei.typ}).` };
      let re: RegExp;
      try { re = new RegExp(args.begriff, "gi"); } catch { re = new RegExp(args.begriff.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"); }
      const umfeld = args.umfeld ?? 200;
      const treffer: Array<{ seite: number; position: number; umfeld: string }> = [];
      let gesamtTreffer = 0;
      seiten.forEach((s, i) => {
        for (const m of s.matchAll(re)) {
          gesamtTreffer++;
          if (treffer.length >= MAX_TREFFER) continue;
          const p = m.index ?? 0;
          treffer.push({ seite: i + 1, position: p, umfeld: s.slice(Math.max(0, p - umfeld), p + m[0].length + umfeld).replace(/\s+/g, " ") });
        }
      });
      return { name: r.datei.filename, begriff: args.begriff, treffer, anzahlGesamt: gesamtTreffer, ...(gesamtTreffer > MAX_TREFFER ? { hinweis: `Nur die ersten ${MAX_TREFFER} von ${gesamtTreffer} Treffern.` } : {}) };
    },
    preview: (r) => ("error" in (r as object) ? `Fehler: ${(r as { error: string }).error}` : `${(r as { anzahlGesamt: number }).anzahlGesamt} Treffer`),
  });

  return [dateiInfo, dateiLesen, dateiSuchen];
}
