// LinkedIn-Leads im Chat (docs/PLAN_LINKEDIN_LEADS.md L5): Leads lesen, uebernehmen,
// ignorieren, beobachtete Posts pflegen. Gleiche Logik wie der Bereich in der App.
// Kein ICP-Tor: der Score ist nur ein Hinweis.

import * as yup from "yup";
import { defineTool } from "../define-tool";
import type { Tool } from "../types";
import type { GatewayClient } from "../gateway-client";
import type { PersonenRadarStore } from "../../linkedin/personen-radar/store";
import type { PersonenRadarSupervisor } from "../../linkedin/personen-radar/supervisor";
import { gwVon, leadIgnorieren, leadUebernehmen, leadsListe } from "../../linkedin/leads-uebernahme";

export interface LinkedInLeadsToolDeps {
  gateway: GatewayClient;
  getPradarStore: () => PersonenRadarStore | null;
  getPradarSupervisor: () => PersonenRadarSupervisor | null;
}

export function buildLinkedInLeadsTools(deps: LinkedInLeadsToolDeps): Tool[] {
  const gw = gwVon(deps.gateway);

  const leads = defineTool({
    name: "linkedin_leads",
    summary: "LinkedIn-Leads lesen: Personen, die auf beobachtete Posts reagiert oder kommentiert haben, mit Firma, Anlass und Kommentar.",
    category: "linkedin leads post reaktion kommentar warm lead ansprache",
    description:
      "Liefert Leads aus beobachteten LinkedIn-Posts (Standard: eigene, offene und ungeklaerte; alle=true: auch die der Kollegen). Jeder Lead: Person, Rolle, Firma mit Ort und Kurzprofil, Art der Reaktion, Kommentartext, Status, wer uebernommen hat, " +
      "und ob ein Kollege dieselbe Person schon uebernommen hat (kollegeUebernommen → vor der Ansprache abstimmen). Der ICP-Score ist hier KEIN Filter: Wer auf einen Post reagiert, ist ein warmer Lead, auch ohne ICP-Match. " +
      "Nutze es fuer Fragen wie 'Welche Leads habe ich?', 'Wer hat auf Hennings Post kommentiert?', 'Zeig mir die Kommentare'. Fuer eine Ansprache den Kommentar und das Kurzprofil der Firma heranziehen.",
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["offen", "ungeklaert", "uebernommen", "ignoriert", "alle"], description: "Standard: offen und ungeklaert." },
        postUrl: { type: "string", description: "Nur Leads dieses Posts." },
        nurKommentare: { type: "boolean" },
        alle: { type: "boolean", description: "Auch Leads der Kolleginnen und Kollegen (Standard: nur eigene)." },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
    },
    schema: yup.object({ status: yup.string().oneOf(["offen", "ungeklaert", "uebernommen", "ignoriert", "alle"]).optional(), postUrl: yup.string().trim().optional(), nurKommentare: yup.boolean().optional(), alle: yup.boolean().optional(), limit: yup.number().integer().min(1).max(100).optional() }).noUnknown(true),
    preview: (r: { gesamt: number }) => `${r.gesamt} Leads`,
    run: async (args) => {
      const r = await leadsListe(gw, { status: args.status, postUrl: args.postUrl, nurKommentare: args.nurKommentare, alle: args.alle, seite: 1, groesse: args.limit ?? 30 });
      return {
        gesamt: r.gesamt,
        hinweis: "Score ist nur ein Hinweis. Eigene Leads; alle=true zeigt die der Organisation. Uebernehmen legt Firma und Person in einem Schritt an (linkedin_lead_uebernehmen).",
        leads: r.items.map((l) => ({
          id: l.id,
          person: l.personName,
          rolle: l.rolle ?? l.headline,
          profileUrl: l.profileUrl,
          firma: l.firmaName,
          ort: l.firmaOrt,
          branche: l.firmaBranche,
          kurzprofil: l.firmaKurz,
          companyId: l.companyId ?? l.masterCompanyId,
          aktivitaet: l.aktivitaet === "comment" ? "Kommentar" : `Reaktion${l.reactionType ? ` (${l.reactionType})` : ""}`,
          kommentar: l.kommentar,
          postUrl: l.postUrl,
          am: l.createdAt,
          status: l.status,
          ...(l.uebernommenVon ? { uebernommenVon: l.uebernommenVon } : {}),
          ...(l.kollegeUebernommen ? { kollegeUebernommen: l.kollegeUebernommen } : {}),
          ...(l.ignoriertGrund ? { ignoriertGrund: l.ignoriertGrund } : {}),
          ...(l.reaktionen > 1 ? { reaktionenGesamt: l.reaktionen } : {}),
          ...(l.status === "ungeklaert" ? { grund: l.grund } : {}),
        })),
      };
    },
  });

  const uebernehmen = defineTool({
    name: "linkedin_lead_uebernehmen",
    summary: "Einen LinkedIn-Lead uebernehmen: Firma in den Bestand, Person als Kontakt mit Anlass — ein Schritt. Fragt vorher nach.",
    category: "linkedin lead uebernehmen kontakt anlegen firma importieren",
    description:
      "Nimmt die Firma des Leads in den Bestand (Registersuche nach Name und Ort, sonst Firma ohne Register ueber die Website), startet die Verarbeitung und legt die Person als Kontakt mit LinkedIn-URL, Rolle und Anlass-Notiz an. " +
      "Danach ist der Lead fuer die ganze Organisation 'uebernommen'. Braucht die leadId aus linkedin_leads.",
    parameters: { type: "object", required: ["leadId"], properties: { leadId: { type: "string" } } },
    schema: yup.object({ leadId: yup.string().trim().min(4).required() }).noUnknown(true),
    preview: (r: { ok?: boolean; companyId?: string; error?: string; abgebrochen?: boolean }) => (r.abgebrochen ? "abgebrochen" : r.ok ? `uebernommen → ${r.companyId}` : `nicht uebernommen: ${r.error ?? "?"}`),
    run: async (args, c) => {
      const value = await c.ui.confirmAction(
        {
          kind: "mutating",
          prompt: "Diesen Lead uebernehmen? Die Firma kommt in den Bestand und wird verarbeitet, die Person wird als Kontakt mit Anlass angelegt. Der Lead gilt danach fuer die ganze Organisation als uebernommen.",
          confirmValue: "uebernehmen",
          options: [{ value: "uebernehmen", label: "Uebernehmen" }, { value: "nein", label: "Abbrechen" }],
        },
        c.signal,
      );
      if (value !== "uebernehmen") return { ok: false, abgebrochen: true };
      return leadUebernehmen(gw, args.leadId);
    },
  });

  const ignorieren = defineTool({
    name: "linkedin_lead_ignorieren",
    summary: "Einen LinkedIn-Lead ignorieren (mit Grund) — verschwindet fuer die ganze Organisation aus den offenen Leads.",
    category: "linkedin lead ignorieren verwerfen",
    description: "Markiert den Lead als ignoriert; der Kommentartext wird dabei geloescht. Grund z. B. 'Kein Entscheider', 'Falsche Branche', 'Wettbewerber'. Laesst sich im Bereich LinkedIn → Leads zuruecknehmen.",
    parameters: { type: "object", required: ["leadId"], properties: { leadId: { type: "string" }, grund: { type: "string" } } },
    schema: yup.object({ leadId: yup.string().trim().min(4).required(), grund: yup.string().trim().max(200).optional() }).noUnknown(true),
    preview: (r: { status?: string; personName?: string | null }) => `${r.personName ?? "Lead"}: ${r.status ?? "?"}`,
    run: async (args) => {
      const r = await leadIgnorieren(gw, args.leadId, args.grund ?? null);
      return { status: r.status, personName: r.personName };
    },
  });

  const posts = defineTool({
    name: "linkedin_posts_beobachten",
    summary: "Beobachtete LinkedIn-Posts anzeigen, hinzufuegen oder entfernen; optional sofort pruefen (kostet Apify-Guthaben).",
    category: "linkedin post beobachten leads quelle hinzufuegen entfernen",
    description:
      "Ohne Parameter: Liste der beobachteten Posts samt Lead-Zaehlern. addPostUrls/removePostUrls pflegen die Liste (max. 25). jetztPruefen=true startet sofort einen Lauf: " +
      "wer auf die Posts reagiert oder kommentiert hat, wird zur Firma aufgeloest und erscheint unter LinkedIn → Leads. Automatik, Intervall und Budgets: personen_radar_config.",
    parameters: {
      type: "object",
      properties: {
        addPostUrls: { type: "array", items: { type: "string" } },
        removePostUrls: { type: "array", items: { type: "string" } },
        jetztPruefen: { type: "boolean", description: "Lauf sofort starten (Apify-Kosten)." },
      },
    },
    schema: yup.object({ addPostUrls: yup.array().of(yup.string().required()).optional(), removePostUrls: yup.array().of(yup.string().required()).optional(), jetztPruefen: yup.boolean().optional() }).noUnknown(true),
    preview: (r: { posts?: unknown[]; lauf?: string; error?: string }) => (r.error ? r.error : r.lauf ? `Lauf: ${r.lauf.slice(0, 60)}` : `${r.posts?.length ?? 0} Posts`),
    run: async (args) => {
      const store = deps.getPradarStore();
      if (!store) return { error: "Beobachtete Posts sind nicht initialisiert." };
      const cfg = store.getConfig();
      let urls = [...cfg.postUrls];
      const aenderungen: string[] = [];
      for (const u of args.addPostUrls ?? []) {
        if (!/linkedin\.com/i.test(u)) { aenderungen.push(`uebersprungen (keine LinkedIn-URL): ${u}`); continue; }
        if (!urls.includes(u)) { urls.push(u); aenderungen.push(`hinzugefuegt: ${u}`); }
      }
      for (const u of args.removePostUrls ?? []) {
        if (urls.includes(u)) { urls = urls.filter((x) => x !== u); aenderungen.push(`entfernt: ${u}`); }
      }
      if (aenderungen.length > 0) store.setConfig({ postUrls: urls.slice(0, 25) });
      let lauf: string | undefined;
      if (args.jetztPruefen) {
        const sup = deps.getPradarSupervisor();
        lauf = sup ? await sup.runNow("manuell") : "Lauf nicht moeglich (nicht initialisiert)";
      }
      const zaehler = await gw<{ posts: Array<{ postUrl: string; leads: number; offen: number; kommentare: number; uebernommen: number }> }>("/v1/linkedin-leads/posts").catch(() => ({ posts: [] }));
      return {
        posts: urls.map((u) => {
          const z = zaehler.posts.find((p) => p.postUrl === u);
          return { postUrl: u, leads: z?.leads ?? 0, offen: z?.offen ?? 0, kommentare: z?.kommentare ?? 0, uebernommen: z?.uebernommen ?? 0 };
        }),
        automatik: cfg.enabled,
        ...(aenderungen.length > 0 ? { aenderungen } : {}),
        ...(lauf ? { lauf } : {}),
      };
    },
  });

  return [leads, uebernehmen, ignorieren, posts];
}
