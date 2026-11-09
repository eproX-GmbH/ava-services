// L1 (docs/PLAN_LOESUNGSKARTEN.md): AVA bietet die passende Seite der App an,
// statt dem Nutzer einen Klickpfad zu diktieren ("kein Werkzeug zur
// App-Navigation"). Benannte Ziele statt freier Pfade, damit das Modell keine
// Adressen erfindet. Fuer "Dienst verbinden" ist die Vorlage vorbelegt.
// Seit Befund Patrick 2026-11-08 kein Sprung mehr: die App sprang auf die
// Seite, bevor man AVAs Erklaerung lesen konnte. Jetzt wird daraus ein Knopf
// unter der Antwort (Orchestrator sammelt `knopf`, wie bei den Karten, L4).

import * as yup from "yup";
import { defineTool } from "../define-tool";
import type { Tool } from "../types";
import { featureEnabled } from "../../org-policy";

interface Ziel {
  pfad: string;
  text: string;
  /** Organisationsfreigabe, ohne die es die Seite nicht gibt. */
  feature?: import("../../../shared/types").OrgFeatureKey;
}

const ZIELE: Record<string, Ziel> = {
  chat: { pfad: "/chat", text: "Chat" },
  firmenliste: { pfad: "/alle-firmen", text: "deine Firmenliste (Meine Firmen)" },
  firmensuche: { pfad: "/companies", text: "die Firmensuche" },
  importieren: { pfad: "/ingest", text: "den Import" },
  radar: { pfad: "/radar", text: "das Firmen-Radar" },
  meldungen: { pfad: "/alerts", text: "deine Meldungen" },
  workflows: { pfad: "/workflows", text: "die Workflows", feature: "workflows" },
  workflow_laeufe: { pfad: "/workflows/laeufe", text: "die Läufe deiner Workflows", feature: "workflows" },
  icp: { pfad: "/icp-assistent", text: "den Assistenten für dein Idealkundenprofil" },
  status: { pfad: "/whoami", text: "die Statusseite" },
  gerade_thema: { pfad: "/thema", text: "„Gerade Thema“", feature: "relevanz" },
  geteilte_buying_center: { pfad: "/buying-center/geteilt", text: "die geteilten Buying Center", feature: "buyingcenter" },
  aufgaben: { pfad: "/transactions", text: "die laufenden Aufgaben" },
  linkedin: { pfad: "/linkedin", text: "den LinkedIn-Bereich" },
  posteingang: { pfad: "/inbox", text: "den Posteingang" },
  dienst_verbinden: { pfad: "/settings/verbindungen#weitere-dienste-section", text: "Einstellungen → Verbindungen → Weitere Dienste" },
  crm_verbinden: { pfad: "/settings/verbindungen#crm-connections", text: "Einstellungen → Verbindungen → CRM" },
  linkedin_verbinden: { pfad: "/settings/verbindungen#linkedin-section", text: "Einstellungen → Verbindungen → LinkedIn" },
  mail_verbinden: { pfad: "/settings/verbindungen#mail-section", text: "Einstellungen → Verbindungen → E-Mail", feature: "mail" },
  mail_entwuerfe: { pfad: "/settings/verbindungen#mail-entwurf-section", text: "Einstellungen → Verbindungen → Mail-Entwürfe" },
  telegram_verbinden: { pfad: "/settings/verbindungen#telegram-section", text: "Einstellungen → Verbindungen → Telegram", feature: "telegram" },
  notizen: { pfad: "/settings/verbindungen#wissensquellen-section", text: "Einstellungen → Verbindungen → Notizen" },
  linkedin_kalibrierung: { pfad: "/settings/verbindungen#signal-kalibrierung", text: "Einstellungen → Verbindungen → LinkedIn-Kalibrierung", feature: "linkedin.beobachter" },
  linkedin_bildanalyse: { pfad: "/settings/verbindungen#linkedin-image-analysis", text: "Einstellungen → Verbindungen → LinkedIn" },
  verbundene_apps: { pfad: "/settings/konto#verbindungen", text: "Einstellungen → Konto → Verbundene Apps" },
  organisation: { pfad: "/settings/konto#organisation", text: "Einstellungen → Konto → Organisation" },
  konto_loeschen: { pfad: "/settings/konto#konto-loeschen", text: "Einstellungen → Konto → Konto löschen (ganz unten)" },
  deine_avas: { pfad: "/settings/konto#instanzen", text: "Einstellungen → Konto → Deine AVAs" },
  langzeitgedaechtnis: { pfad: "/settings/konto#general-memory", text: "Einstellungen → Konto → Langzeitgedächtnis" },
  erlaubnisse: { pfad: "/settings/konto#erlaubnisse-section", text: "Einstellungen → Konto → Erlaubnisse" },
  lokale_modelle: { pfad: "/settings/ki#installed-models", text: "Einstellungen → KI & Kosten → Modelle auf diesem Rechner" },
  verbrauch_limit: { pfad: "/settings/ki#verbrauch-limit", text: "Einstellungen → KI & Kosten → Verbrauch" },
  sprachmodus: { pfad: "/settings/ki#sprachmodus-section", text: "Einstellungen → KI & Kosten → Mit AVA sprechen", feature: "sprachmodus" },
  spracherkennung: { pfad: "/settings/ki#voice-settings", text: "Einstellungen → KI & Kosten → Spracherkennung" },
  beobachtungen: { pfad: "/settings/recherche#watches-section", text: "Einstellungen → Recherche → Beobachtungen" },
  link_ueberwachung: { pfad: "/settings/recherche#link-monitor-section", text: "Einstellungen → Recherche → Link-Überwachung" },
  email_adressen: { pfad: "/settings/recherche#email-muster-section", text: "Einstellungen → Recherche → E-Mail-Adressen" },
  naehe_vorrang: { pfad: "/settings/meldungen#relevanz-section", text: "Einstellungen → Meldungen → Nähe & Vorrang", feature: "relevanz" },
  skills: { pfad: "/settings/erweitert#skills-list", text: "Einstellungen → Erweitert → Skills" },
  wiederkehrende_aufgaben: { pfad: "/settings/erweitert#scheduler-section", text: "Einstellungen → Erweitert → Wiederkehrende Aufgaben", feature: "mail" },
  verlauf: { pfad: "/settings/erweitert#audit-trail", text: "Einstellungen → Erweitert → Verlauf" },
  updates: { pfad: "/settings/erweitert#updates", text: "Einstellungen → Erweitert → Updates" },
  speicherplatz: { pfad: "/settings/erweitert#storage", text: "Einstellungen → Erweitert → Speicherplatz" },
  diagnose: { pfad: "/settings/erweitert#diagnose", text: "Einstellungen → Erweitert → Diagnose" },
  dienste_rechner: { pfad: "/settings/erweitert#dienste-section", text: "Einstellungen → Erweitert → Dienste auf diesem Rechner" },
  zuruecksetzen: { pfad: "/settings/erweitert#danger-zone", text: "Einstellungen → Erweitert → Zurücksetzen" },
  modell: { pfad: "/settings/ki#provider-section", text: "Einstellungen → KI & Kosten → Anbieter & Modell" },
  chatgpt_abo: { pfad: "/settings/ki#chatgpt-abo", text: "Einstellungen → KI & Kosten → ChatGPT-Abo" },
  verbrauch: { pfad: "/settings/ki#verbrauch-section", text: "Einstellungen → KI & Kosten → Verbrauch" },
  plan: { pfad: "/settings/konto#plan-section", text: "Einstellungen → Konto → Plan & Abrechnung" },
  profil: { pfad: "/settings/konto#profile-section", text: "Einstellungen → Konto → Profil" },
  themen: { pfad: "/settings/recherche#themen-section", text: "Einstellungen → Recherche → Fokus-Themen" },
  meldungen_einstellen: { pfad: "/settings/meldungen#alerts-section", text: "Einstellungen → Meldungen" },
  stammdaten_mitpflegen: { pfad: "/settings/recherche#mithelfen-section", text: "Einstellungen → Recherche → Stammdaten mitpflegen", feature: "stammdaten.mithelfen" },
  chat_anzeige: { pfad: "/settings/meldungen#vorschlaege-section", text: "Einstellungen → Meldungen → Vorschläge im Chat" },
};

/** Vorlagen der Dienste-Seite (DiensteSection.tsx); andere Namen fuellen nur das Namensfeld. */
const DIENST_VORLAGEN = new Set(["close", "compleadly"]);

/** Ziel → Pfad in der App (auch fuer Knoepfe der Loesungskarten, L4). */
export function zielAufloesen(
  ziel: string,
  opts: { companyId?: string; vorgangId?: string; dienst?: string } = {},
): { pfad: string; text: string } | { hinweis: string; fehler?: boolean } {
  if (ziel === "firma") {
    if (!opts.companyId) return { hinweis: "companyId fehlt", fehler: true };
    return { pfad: `/companies/${encodeURIComponent(opts.companyId)}`, text: "die Firmenseite" };
  }
  if (ziel === "vorgang") {
    if (!opts.vorgangId) return { hinweis: "vorgangId fehlt", fehler: true };
    return { pfad: `/transactions/${encodeURIComponent(opts.vorgangId)}`, text: "die Aufgabe" };
  }
  const z = ZIELE[ziel];
  if (!z) return { hinweis: `unbekanntes Ziel ${ziel}`, fehler: true };
  if (z.feature && !featureEnabled(z.feature)) return { hinweis: "Diese Funktion hat deine Organisation abgeschaltet. Sag das in einem Satz, ohne den Weg zu beschreiben." };
  let pfad = z.pfad;
  if (ziel === "dienst_verbinden" && opts.dienst) {
    const slug = opts.dienst.toLowerCase().replace(/[^a-z0-9]+/g, "");
    const q = DIENST_VORLAGEN.has(slug) ? `vorlage=${slug}` : `name=${encodeURIComponent(opts.dienst)}`;
    pfad = `/settings/verbindungen?${q}#weitere-dienste-section`;
  }
  return { pfad, text: z.text };
}

/** "deine Firmenliste (Meine Firmen)" → "Deine Firmenliste (Meine Firmen)" */
function knopfLabel(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function buildAppOeffnenTools(): Tool[] {
  const oeffnen = defineTool({
    name: "app_oeffnen",
    summary: "Legt unter die Antwort einen Knopf zu einer Seite der App (Firma, Firmenliste, Einstellungen, Dienst verbinden, Plan, Modell …)",
    category: "ui navigation seite oeffnen einstellungen verbinden",
    description:
      "Legt unter deine Antwort einen Knopf, der die passende Seite der App öffnet, statt dem Nutzer einen Klickpfad zu beschreiben. Die Seite öffnet sich erst, wenn der Nutzer klickt; sag also nie, du hättest sie geöffnet, und beschreib den Knopf nicht. " +
      "Nutze es, sobald der Nutzer etwas nur dort erledigen kann (Zugang hinterlegen, Dienst/CRM/LinkedIn/Mail verbinden, Plan, Modell) " +
      "oder eine Ansicht sehen will. ziel=dienst_verbinden mit `dienst` (z. B. compleadly, close) öffnet das Formular mit vorbelegtem Dienst. " +
      "ziel=firma braucht `companyId`, ziel=vorgang `vorgangId`. firmenliste = Meine Firmen, firmensuche = Suche über alle Firmen im Register. In deiner Antwort in einem Satz sagen, was der Nutzer dort tut; Zugangsdaten nie im Chat erfragen. " +
      "Wirkt nur in der Desktop-App; auf Telegram kommt ein Hinweis zurück, dann den Weg in Worten nennen.",
    parameters: {
      type: "object",
      properties: {
        ziel: { type: "string", enum: ["firma", "vorgang", ...Object.keys(ZIELE)], description: "Welche Seite" },
        companyId: { type: "string", description: "Nur bei ziel=firma" },
        vorgangId: { type: "string", description: "Nur bei ziel=vorgang (Id einer laufenden oder erledigten Aufgabe, z. B. eines Imports)" },
        dienst: { type: "string", description: "Nur bei ziel=dienst_verbinden: Name des Dienstes" },
      },
      required: ["ziel"],
    },
    schema: yup.object({
      ziel: yup.string().oneOf(["firma", "vorgang", ...Object.keys(ZIELE)]).required(),
      companyId: yup.string().trim().max(120).optional(),
      vorgangId: yup.string().trim().max(120).optional(),
      dienst: yup.string().trim().max(60).optional(),
    }),
    run: async (args, ctx) => {
      if (ctx.autonomousMode || (ctx.conversationId ?? "").startsWith("telegram-")) {
        const z = ZIELE[args.ziel] ?? null;
        return { geoeffnet: false, hinweis: `Hier gibt es keine App-Oberfläche. Nenne den Weg in der Desktop-App${z ? `: ${z.text}` : ""}.` };
      }
      const z = zielAufloesen(args.ziel, args);
      if ("hinweis" in z) return { geoeffnet: false, ...(z.fehler ? { error: z.hinweis } : { hinweis: z.hinweis }) };
      const { pfad, text } = z;
      return { geoeffnet: false, knopf: { label: knopfLabel(text), pfad }, hinweis: "Unter deiner Antwort erscheint ein Knopf zu dieser Seite." };
    },
    preview: (r: Record<string, unknown>) => (r.knopf ? `Knopf zu ${(r.knopf as { label: string }).label}` : String(r.hinweis ?? r.error ?? "nicht geöffnet")),
  });
  return [oeffnen];
}
