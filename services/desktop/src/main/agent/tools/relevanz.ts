// Chat-Werkzeuge fuer die Relevanz (docs/PLAN_RELEVANZ.md, Abschnitt 11).
//
// Jede Einstellung braucht auch einen Weg ueber den Chat — sonst muss der
// Nutzer wissen, in welchem Einstellungsbereich etwas liegt, und genau das
// soll AVA ihm abnehmen.
//
// Vier Werkzeuge: nachsehen, Arbeitsvorschau, vergessen, ein- und
// ausschalten. Die beiden letzten aendern etwas und fragen deshalb nach.
//
// Was es hier bewusst NICHT gibt: eine Auswertung ueber Nutzer hinweg. Das
// Aggregat "Gerade Thema" zaehlt Firmen, nicht Menschen, und liegt an
// seinem eigenen Werkzeug — wer wissen will, WER an einer Firma dranhaengt,
// fragt im Team.

import * as yup from "yup";
import { defineTool } from "../define-tool";
import type { Tool } from "../types";
import * as relevanz from "../../relevanz";
import { labelFuer } from "../../relevanz/katalog";
import { featureEnabled } from "../../org-policy";

/** Klartext fuer eine Naehe. Zahlen allein sagen einem Modell wenig. */
function stufe(naehe: number): string {
  if (naehe >= 8.5) return "heiss";
  if (naehe >= 6) return "warm";
  if (naehe >= 4) return "lauwarm";
  return "kalt";
}

function ausgeschaltet(): { error: string } | null {
  if (!featureEnabled("relevanz")) {
    return { error: "Die Relevanz-Funktion ist in dieser Organisation abgeschaltet." };
  }
  if (!relevanz.aktiv()) {
    return {
      error:
        "Die Relevanz-Erfassung ist ausgeschaltet. Mit relevanz_einstellen laesst sie sich einschalten.",
    };
  }
  return null;
}

export function buildRelevanzTools(): Tool[] {
  const status = defineTool({
    name: "relevanz_status",
    description:
      "Zeigt, wie nah der Nutzer an einer Firma oder Person dran ist: Naehe 1-10 (aus seinem eigenen Verhalten), Gewicht 1-10 (sachliche Passung aus ICP und Firmenstatus) und die staerksten Gruende. Nutze das, wenn der Nutzer fragt, warum eine Firma als wichtig gilt, warum er zu ihr Meldungen bekommt (oder keine), oder wie 'heiss' sie ist. Ohne Argumente kommt der eigene Gesamtstand.",
    parameters: {
      type: "object",
      properties: {
        zielArt: { type: "string", enum: ["firma", "person"], description: "Standard: firma." },
        ids: {
          type: "array",
          items: { type: "string" },
          description: "companyIds oder personIds. Leer = die obersten Eintraege.",
        },
      },
    },
    schema: yup
      .object({
        zielArt: yup.string().oneOf(["firma", "person"]).optional(),
        ids: yup.array().of(yup.string().required()).max(50).optional(),
      })
      .noUnknown(true),
    run: async (args) => {
      const aus = ausgeschaltet();
      if (aus) return aus;
      const zielArt = (args.zielArt ?? "firma") as "firma" | "person";
      const werte =
        args.ids && args.ids.length > 0
          ? Array.from((await relevanz.werte(zielArt, args.ids)).values())
          : await relevanz.vorschau(20);
      if (werte.length === 0) {
        return {
          hinweis:
            "Zu diesen Zielen liegt noch nichts vor. Die Naehe entsteht erst, wenn der Nutzer mit einer Firma arbeitet.",
        };
      }
      return {
        werte: werte.map((w) => ({
          zielArt: w.zielArt,
          zielId: w.zielId,
          naehe: w.naehe,
          stufe: stufe(w.naehe),
          gewicht: w.gewicht,
          rang: w.rang,
          gruende: w.begruendung.map((b) => ({
            was: labelFuer(b.art),
            wieOft: b.anzahl,
          })),
          letztesSignal: w.letztesSignal,
        })),
        erklaerung:
          "Naehe kommt aus dem Verhalten des Nutzers und verfaellt. Gewicht kommt aus der Sachlage und verfaellt nicht. Der Rang mischt beide und steuert, was der Hintergrund beobachtet und welche Meldungen sofort kommen.",
      };
    },
    preview: (r) =>
      "werte" in r && Array.isArray(r.werte)
        ? `${r.werte.length} Eintrag/Eintraege bewertet`
        : "noch keine Bewertung",
  });

  const vorschau = defineTool({
    name: "relevanz_vorschau",
    description:
      "Listet die Firmen, die AVA im Hintergrund als naechstes beobachtet, nach Rang sortiert. Nutze das, wenn der Nutzer wissen will, worauf AVA gerade achtet oder warum eine bestimmte Firma nicht vorkommt. Das ist KEINE Rangliste ueber Nutzer, sondern die Arbeitsvorschau des eigenen Hintergrundlaufs.",
    parameters: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 100 } },
    },
    schema: yup.object({ limit: yup.number().integer().min(1).max(100).optional() }).noUnknown(true),
    run: async (args) => {
      const aus = ausgeschaltet();
      if (aus) return aus;
      const werte = await relevanz.vorschau(args.limit ?? 25);
      return {
        anzahl: werte.length,
        firmen: werte.map((w) => ({
          companyId: w.zielId,
          rang: w.rang,
          naehe: w.naehe,
          stufe: stufe(w.naehe),
          gewicht: w.gewicht,
        })),
        hinweis:
          "Jeder vierte Platz ist fuer Firmen mit hoher sachlicher Passung reserviert, die der Nutzer noch nie angesehen hat.",
      };
    },
    preview: (r) => ("anzahl" in r ? `${r.anzahl} Firmen in der Vorschau` : "Vorschau leer"),
  });

  const vergessen = defineTool({
    name: "relevanz_vergessen",
    description:
      "Loescht die gesammelten Relevanz-Signale — entweder zu einer bestimmten Firma oder Person, oder alle. Nutze das, wenn der Nutzer sagt, AVA solle eine Firma 'vergessen', sich nicht mehr merken, was er angesehen hat, oder wenn er seine Daten loeschen will. Fragt vorher nach. Die Loeschung ist endgueltig.",
    parameters: {
      type: "object",
      properties: {
        zielArt: { type: "string", enum: ["firma", "person"] },
        zielId: { type: "string", description: "Weglassen, um ALLES zu loeschen." },
      },
    },
    schema: yup
      .object({
        zielArt: yup.string().oneOf(["firma", "person"]).optional(),
        zielId: yup.string().trim().max(200).optional(),
      })
      .noUnknown(true),
    run: async (args, c) => {
      const einzeln = Boolean(args.zielId);
      const value = await c.ui.confirmAction(
        {
          // Loeschen ist nicht rueckholbar — die Signale entstehen aus
          // Handlungen, die nicht wiederholt werden.
          kind: "destructive",
          prompt: einzeln
            ? `Die gesammelten Signale zu ${args.zielId} loeschen? AVA vergisst damit, dass du dich mit diesem Eintrag befasst hast. Das laesst sich nicht rueckgaengig machen.`
            : `ALLE Relevanz-Signale loeschen? AVA vergisst damit, mit welchen Firmen und Personen du dich befasst hast, und beobachtet danach wieder nach reiner Sachlage. Das laesst sich nicht rueckgaengig machen.`,
          confirmValue: "loeschen",
          options: [
            { value: "loeschen", label: "Loeschen", description: einzeln ? "nur diesen Eintrag" : "alles" },
            { value: "cancel", label: "Abbrechen" },
          ],
        },
        c.signal,
      );
      if (value !== "loeschen") return { abgebrochen: true };
      const ok = await relevanz.vergessen(
        args.zielArt as "firma" | "person" | undefined,
        args.zielId,
      );
      return ok
        ? { geloescht: true, umfang: einzeln ? args.zielId : "alles" }
        : { error: "Loeschen fehlgeschlagen. Besteht eine Verbindung?" };
    },
    preview: (r) =>
      "geloescht" in r ? `geloescht: ${String(r.umfang)}` : "nicht geloescht",
  });

  const einstellen = defineTool({
    name: "relevanz_einstellen",
    description:
      "Schaltet die Relevanz-Erfassung ein oder aus. Aus bedeutet: AVA merkt sich nicht mehr, welche Firmen und Personen der Nutzer ansieht, und beobachtet im Hintergrund wieder nach reiner Sachlage. Nutze das, wenn der Nutzer die Erfassung nicht will. Ohne Argument kommt nur der aktuelle Stand. Fragt vor einer Aenderung nach.",
    parameters: {
      type: "object",
      properties: { an: { type: "boolean", description: "Weglassen = nur nachsehen." } },
    },
    schema: yup.object({ an: yup.boolean().optional() }).noUnknown(true),
    run: async (args, c) => {
      if (!featureEnabled("relevanz")) {
        return { error: "Die Relevanz-Funktion ist in dieser Organisation abgeschaltet." };
      }
      const jetzt = relevanz.aktiv();
      if (args.an === undefined) {
        return {
          an: jetzt,
          selbstbestimmt: relevanz.selbstbestimmt(),
          hinweis: relevanz.selbstbestimmt()
            ? "Der Nutzer kann das selbst aendern."
            : "Die Organisation hat das verbindlich gesetzt; der Nutzer kann es nicht aendern.",
        };
      }
      if (!relevanz.selbstbestimmt()) {
        // Lieber eine klare Absage als still nichts tun: Sonst glaubt das
        // Modell, es haette etwas geaendert, und sagt es dem Nutzer auch.
        return {
          error:
            "Die Organisation hat diese Einstellung verbindlich gesetzt. Sie laesst sich hier nicht aendern.",
        };
      }
      if (args.an === jetzt) return { an: jetzt, unveraendert: true };
      const value = await c.ui.confirmAction(
        {
          kind: args.an ? "additive" : "destructive",
          prompt: args.an
            ? "Relevanz-Erfassung einschalten? AVA merkt sich dann wieder, welche Firmen und Personen du ansiehst, und richtet die Hintergrundbeobachtung danach aus. Die Daten liegen in deinem AVA-Konto und sind fuer niemanden sonst sichtbar."
            : "Relevanz-Erfassung ausschalten? AVA merkt sich dann nicht mehr, womit du dich befasst, und beobachtet im Hintergrund nur noch nach Sachlage. Bereits gesammelte Signale bleiben erhalten — zum Loeschen gibt es relevanz_vergessen.",
          confirmValue: "ja",
          options: [
            { value: "ja", label: args.an ? "Einschalten" : "Ausschalten" },
            { value: "cancel", label: "Abbrechen" },
          ],
        },
        c.signal,
      );
      if (value !== "ja") return { abgebrochen: true };
      relevanz.setzeAn(args.an);
      return { an: relevanz.aktiv() };
    },
    preview: (r) => ("an" in r ? `Erfassung ${r.an ? "an" : "aus"}` : "unveraendert"),
  });

  const thema = defineTool({
    name: "relevanz_thema",
    description:
      "Zeigt, welche Firmen die Organisation gerade beschaeftigen: je Firma die ANZAHL der Mitglieder, die sie derzeit warm haben. Ohne Namen — wer genau dranhaengt, steht hier bewusst nicht. Nutze das, wenn der Nutzer wissen will, woran das Team gerade arbeitet oder ob sich jemand mit derselben Firma befasst.",
    parameters: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 100 } },
    },
    schema: yup.object({ limit: yup.number().integer().min(1).max(100).optional() }).noUnknown(true),
    run: async (args) => {
      const r = await relevanz.thema(args.limit ?? 25);
      if (!r.verfuegbar) {
        const gruende: Record<string, string> = {
          funktion_abgeschaltet: "Die Relevanz-Funktion ist in dieser Organisation abgeschaltet.",
          aggregat_abgeschaltet: "Die Organisation zeigt diese Uebersicht nicht an.",
          organisation_zu_klein:
            "Die Uebersicht gibt es erst ab drei Mitgliedern — bei weniger liesse sich aus einer Zahl auf eine einzelne Person schliessen.",
          nicht_erreichbar: "Die Uebersicht ist gerade nicht abrufbar.",
        };
        return { verfuegbar: false, grund: gruende[r.grund ?? ""] ?? "Nicht verfuegbar." };
      }
      return {
        verfuegbar: true,
        firmen: r.firmen,
        hinweis:
          "Nur Anzahlen, keine Namen. Angezeigt wird eine Firma erst ab zwei Mitgliedern, die sie warm haben.",
      };
    },
    preview: (r) =>
      "firmen" in r && Array.isArray(r.firmen)
        ? `${r.firmen.length} Firmen sind gerade Thema`
        : "Uebersicht nicht verfuegbar",
  });

  return [status, vorschau, vergessen, einstellen, thema];
}
