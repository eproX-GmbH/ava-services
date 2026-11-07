// L1 (docs/PLAN_LOESUNGSKARTEN.md): AVA oeffnet die passende Seite der App
// selbst, statt dem Nutzer einen Klickpfad zu diktieren ("kein Werkzeug zur
// App-Navigation"). Benannte Ziele statt freier Pfade, damit das Modell keine
// Adressen erfindet. Fuer "Dienst verbinden" ist die Vorlage vorbelegt.

import * as yup from "yup";
import { defineTool } from "../define-tool";
import type { Tool } from "../types";

interface Ziel {
  pfad: string;
  text: string;
}

const ZIELE: Record<string, Ziel> = {
  chat: { pfad: "/chat", text: "Chat" },
  firmenliste: { pfad: "/companies", text: "deine Firmenliste" },
  alle_firmen: { pfad: "/alle-firmen", text: "die Suche über alle Firmen" },
  radar: { pfad: "/radar", text: "das Firmen-Radar" },
  meldungen: { pfad: "/alerts", text: "deine Meldungen" },
  workflows: { pfad: "/workflows", text: "die Workflows" },
  aufgaben: { pfad: "/transactions", text: "die laufenden Aufgaben" },
  linkedin: { pfad: "/linkedin", text: "den LinkedIn-Bereich" },
  posteingang: { pfad: "/inbox", text: "den Posteingang" },
  dienst_verbinden: { pfad: "/settings/verbindungen#weitere-dienste-section", text: "Einstellungen → Verbindungen → Weitere Dienste" },
  crm_verbinden: { pfad: "/settings/verbindungen#crm-connections", text: "Einstellungen → Verbindungen → CRM" },
  linkedin_verbinden: { pfad: "/settings/verbindungen#linkedin-section", text: "Einstellungen → Verbindungen → LinkedIn" },
  mail_verbinden: { pfad: "/settings/verbindungen#mail-section", text: "Einstellungen → Verbindungen → E-Mail" },
  telegram_verbinden: { pfad: "/settings/verbindungen#telegram-section", text: "Einstellungen → Verbindungen → Telegram" },
  modell: { pfad: "/settings/ki#provider-section", text: "Einstellungen → KI & Kosten → Anbieter & Modell" },
  chatgpt_abo: { pfad: "/settings/ki#chatgpt-abo", text: "Einstellungen → KI & Kosten → ChatGPT-Abo" },
  verbrauch: { pfad: "/settings/ki#verbrauch-section", text: "Einstellungen → KI & Kosten → Verbrauch" },
  plan: { pfad: "/settings/konto#plan-section", text: "Einstellungen → Konto → Plan & Abrechnung" },
  profil: { pfad: "/settings/konto#profile-section", text: "Einstellungen → Konto → Profil" },
  themen: { pfad: "/settings/recherche#themen-section", text: "Einstellungen → Recherche → Fokus-Themen" },
  meldungen_einstellen: { pfad: "/settings/meldungen#alerts-section", text: "Einstellungen → Meldungen" },
  chat_anzeige: { pfad: "/settings/meldungen#vorschlaege-section", text: "Einstellungen → Meldungen → Vorschläge im Chat" },
};

/** Vorlagen der Dienste-Seite (DiensteSection.tsx); andere Namen fuellen nur das Namensfeld. */
const DIENST_VORLAGEN = new Set(["close", "compleadly"]);

export function buildAppOeffnenTools(): Tool[] {
  const oeffnen = defineTool({
    name: "app_oeffnen",
    summary: "Öffnet eine Seite der App für den Nutzer (Firma, Firmenliste, Einstellungen, Dienst verbinden, Plan, Modell …)",
    category: "ui navigation seite oeffnen einstellungen verbinden",
    description:
      "Öffnet für den Nutzer direkt die passende Seite der App, statt ihm einen Klickpfad zu beschreiben. " +
      "Nutze es, sobald der Nutzer etwas nur dort erledigen kann (Zugang hinterlegen, Dienst/CRM/LinkedIn/Mail verbinden, Plan, Modell) " +
      "oder eine Ansicht sehen will. ziel=dienst_verbinden mit `dienst` (z. B. compleadly, close) öffnet das Formular mit vorbelegtem Dienst. " +
      "ziel=firma braucht `companyId`. Danach in einem Satz sagen, was der Nutzer dort tut; Zugangsdaten nie im Chat erfragen. " +
      "Wirkt nur in der Desktop-App; auf Telegram kommt ein Hinweis zurück, dann den Weg in Worten nennen.",
    parameters: {
      type: "object",
      properties: {
        ziel: { type: "string", enum: ["firma", ...Object.keys(ZIELE)], description: "Welche Seite" },
        companyId: { type: "string", description: "Nur bei ziel=firma" },
        dienst: { type: "string", description: "Nur bei ziel=dienst_verbinden: Name des Dienstes" },
      },
      required: ["ziel"],
    },
    schema: yup.object({
      ziel: yup.string().oneOf(["firma", ...Object.keys(ZIELE)]).required(),
      companyId: yup.string().trim().max(120).optional(),
      dienst: yup.string().trim().max(60).optional(),
    }),
    run: async (args, ctx) => {
      if (ctx.autonomousMode || (ctx.conversationId ?? "").startsWith("telegram-")) {
        const z = args.ziel === "firma" ? null : ZIELE[args.ziel];
        return { geoeffnet: false, hinweis: `Hier gibt es keine App-Oberfläche. Nenne den Weg in der Desktop-App${z ? `: ${z.text}` : ""}.` };
      }
      let pfad: string;
      let text: string;
      if (args.ziel === "firma") {
        if (!args.companyId) return { geoeffnet: false, error: "companyId fehlt" };
        pfad = `/companies/${encodeURIComponent(args.companyId)}`;
        text = "die Firmenseite";
      } else {
        const z = ZIELE[args.ziel]!;
        pfad = z.pfad;
        text = z.text;
        if (args.ziel === "dienst_verbinden" && args.dienst) {
          const slug = args.dienst.toLowerCase().replace(/[^a-z0-9]+/g, "");
          const q = DIENST_VORLAGEN.has(slug) ? `vorlage=${slug}` : `name=${encodeURIComponent(args.dienst)}`;
          pfad = `/settings/verbindungen?${q}#weitere-dienste-section`;
        }
      }
      ctx.ui.navigate(pfad);
      return { geoeffnet: true, seite: text };
    },
    preview: (r: Record<string, unknown>) => (r.geoeffnet ? `${String(r.seite)} geöffnet` : String(r.hinweis ?? r.error ?? "nicht geöffnet")),
  });
  return [oeffnen];
}
