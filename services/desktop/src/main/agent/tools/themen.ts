// Fokus-Themen (docs/PLAN_THEMEN.md, T1): Self-Service im Chat. Jede
// Aenderung mit Bestaetigung; Begriffe schlaegt das Modell selbst vor und
// speichert sie ueber themen_begriffe.

import * as yup from "yup";
import { defineTool } from "../define-tool";
import type { Tool } from "../types";
import type { ThemenStore } from "../../themen/store";
import { MAX_AKTIVE_THEMEN, type Thema } from "../../../shared/themen-types";

function kompakt(t: Thema) {
  return {
    id: t.id,
    name: t.name,
    beschreibung: t.beschreibung,
    warum: t.warum,
    begriffe: t.begriffe.map((b) => b.text),
    aktiv: t.aktiv,
    quelle: t.quelle,
  };
}

export function buildThemenTools(deps: { get: () => ThemenStore | null }): Tool[] {
  const lesen = defineTool({
    name: "themen_get",
    summary: "Fokus-Themen des Nutzers lesen: wonach der Website-Producer bei jeder Firma zusaetzlich sucht (z. B. betriebliche Altersvorsorge).",
    category: "themen website-themen suche signale einstellung",
    description:
      "Liest die Fokus-Themen: Name, Beschreibung, Wozu, Suchbegriffe, aktiv. Der Website-Producer prueft jedes aktive Thema bei jeder Firma " +
      "auf deren Website (Seitenwahl, Begriffssuche, Urteil mit Zitat); der Befund steht in company_get Bereich themen. " +
      "Hat der Nutzer noch keine Themen, schlage ihm aus seinem ICP (Angebot, Nutzen) zwei bis drei vor und lege sie nach Bestaetigung mit themen_set an.",
    parameters: { type: "object", properties: {} },
    schema: yup.object({}).noUnknown(true),
    preview: (r: Record<string, any>) => (r.error ? r.error : `${r.themen?.length ?? 0} Themen`),
    run: async () => {
      const s = deps.get();
      if (!s) return { error: "Themen noch nicht initialisiert." };
      const themen = s.list();
      return {
        themen: themen.map(kompakt),
        maxAktiv: MAX_AKTIVE_THEMEN,
        ...(themen.length === 0 ? { hinweis: "Noch keine Fokus-Themen. Vorschlag aus dem ICP machen und nach Bestaetigung mit themen_set anlegen." } : {}),
      };
    },
  });

  const setzen = defineTool({
    name: "themen_set",
    summary: "Fokus-Thema anlegen, aendern, ein-/ausschalten oder loeschen (mit Bestaetigung).",
    category: "themen website-themen anlegen aendern loeschen einstellung",
    description:
      "Legt ein Fokus-Thema an oder aendert es: name (kurz, z. B. \"Betriebliche Altersvorsorge\"), beschreibung (ein Satz, was gemeint ist), " +
      "warum (wozu der Nutzer es braucht, fliesst in das Urteil ein), begriffe (Suchbegriffe des Nutzers), aktiv. Mit loeschen=true wird das Thema entfernt. " +
      `Hoechstens ${MAX_AKTIVE_THEMEN} Themen gleichzeitig aktiv. Nach dem Anlegen Synonyme ergaenzen: themen_begriffe. ` +
      "Immer erst mit dem Nutzer abstimmen; das Werkzeug fragt zusaetzlich nach Bestaetigung.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Bestehendes Thema (sonst neu)" },
        name: { type: "string" },
        beschreibung: { type: "string" },
        warum: { type: "string" },
        begriffe: { type: "array", items: { type: "string" } },
        aktiv: { type: "boolean" },
        loeschen: { type: "boolean" },
        quelle: { type: "string", enum: ["nutzer", "icp"], description: "icp = aus dem ICP vorgeschlagen" },
      },
    },
    schema: yup
      .object({
        id: yup.string().trim().optional(),
        name: yup.string().trim().max(80).optional(),
        beschreibung: yup.string().trim().max(300).optional(),
        warum: yup.string().trim().max(300).optional(),
        begriffe: yup.array().of(yup.string().trim().max(60).required()).max(40).optional(),
        aktiv: yup.boolean().optional(),
        loeschen: yup.boolean().optional(),
        quelle: yup.string().oneOf(["nutzer", "icp"]).optional(),
      })
      .noUnknown(true),
    preview: (r: Record<string, any>) => (r.error ? r.error : r.geloescht ? "Thema geloescht" : r.thema ? `Thema: ${r.thema.name}` : "abgebrochen"),
    run: async (args, c) => {
      const s = deps.get();
      if (!s) return { error: "Themen noch nicht initialisiert." };
      const alt = args.id ? s.get(args.id) : null;
      if (args.loeschen) {
        if (!alt) return { error: "Thema nicht gefunden." };
        const v = await c.ui.confirmAction(
          { kind: "destructive", prompt: `Fokus-Thema „${alt.name}“ löschen? Bestehende Befunde zu Firmen bleiben erhalten.`, confirmValue: "ja", options: [{ value: "ja", label: "Löschen" }, { value: "nein", label: "Abbrechen" }] },
          c.signal,
        );
        if (v !== "ja") return { geloescht: false, abgebrochen: true };
        return { geloescht: s.loeschen(alt.id) };
      }
      const name = args.name ?? alt?.name;
      if (!name) return { error: "name fehlt." };
      const teile = [
        `Name: ${name}`,
        args.beschreibung ? `Beschreibung: ${args.beschreibung}` : "",
        args.warum ? `Wozu: ${args.warum}` : "",
        args.begriffe?.length ? `Begriffe: ${args.begriffe.join(", ")}` : "",
        args.aktiv !== undefined ? `aktiv: ${args.aktiv ? "ja" : "nein"}` : "",
      ].filter(Boolean);
      const v = await c.ui.confirmAction(
        { kind: "additive", prompt: `${alt ? "Fokus-Thema ändern" : "Fokus-Thema anlegen"}: ${teile.join(" · ")}?`, confirmValue: "ja", options: [{ value: "ja", label: alt ? "Ändern" : "Anlegen" }, { value: "nein", label: "Abbrechen" }] },
        c.signal,
      );
      if (v !== "ja") return { gespeichert: false, abgebrochen: true };
      try {
        const t = s.speichern({ id: alt?.id, name, beschreibung: args.beschreibung, warum: args.warum, begriffe: args.begriffe, aktiv: args.aktiv, quelle: args.quelle });
        return { gespeichert: true, thema: kompakt(t), hinweis: "Jetzt Suchbegriffe und Synonyme ergaenzen (themen_begriffe). Der naechste Website-Lauf je Firma prueft das Thema; gezielt: research_run mit feature themen." };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  });

  const begriffe = defineTool({
    name: "themen_begriffe",
    summary: "Suchbegriffe/Synonyme zu einem Fokus-Thema ergaenzen (vom Modell vorgeschlagen, mit Bestaetigung gespeichert).",
    category: "themen website-themen begriffe synonyme",
    description:
      "Speichert von AVA vorgeschlagene Suchbegriffe zu einem Thema (ersetzt die bisherigen AVA-Begriffe, Nutzer-Begriffe bleiben). " +
      "Schlage 8 bis 15 Begriffe vor: Synonyme, Wortstaemme, Schreibweisen, englische Entsprechungen, Abkuerzungen — nur Woerter oder kurze Wortgruppen, " +
      "die so auf einer Website stehen koennten.",
    parameters: {
      type: "object",
      properties: { id: { type: "string" }, begriffe: { type: "array", items: { type: "string" } } },
      required: ["id", "begriffe"],
    },
    schema: yup.object({ id: yup.string().trim().required(), begriffe: yup.array().of(yup.string().trim().max(60).required()).min(1).max(40).required() }).noUnknown(true),
    preview: (r: Record<string, any>) => (r.error ? r.error : r.thema ? `${r.thema.begriffe.length} Begriffe` : "abgebrochen"),
    run: async (args, c) => {
      const s = deps.get();
      if (!s) return { error: "Themen noch nicht initialisiert." };
      const t = s.get(args.id);
      if (!t) return { error: "Thema nicht gefunden." };
      const v = await c.ui.confirmAction(
        { kind: "additive", prompt: `Begriffe für „${t.name}“ speichern: ${args.begriffe.join(", ")}?`, confirmValue: "ja", options: [{ value: "ja", label: "Speichern" }, { value: "nein", label: "Abbrechen" }] },
        c.signal,
      );
      if (v !== "ja") return { gespeichert: false, abgebrochen: true };
      return { gespeichert: true, thema: kompakt(s.begriffeErgaenzen(t.id, args.begriffe)) };
    },
  });

  return [lesen, setzen, begriffe];
}
