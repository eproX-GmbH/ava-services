// Phase 3 Firmen-Discovery — ICP-Tools.
//
// icp_get / icp_set: Idealkundenprofil lesen/aktualisieren. Wird u. a.
// benutzt, wenn der Nutzer die ICP-Frage aus der Begruessung
// beantwortet — der Agent haelt die Antwort strukturiert hier fest.

import * as yup from "yup";
import { defineTool } from "../define-tool";
import type { GatewayClient } from "../gateway-client";
import type { LlmProviderManager } from "../providers";
import type { IcpStore } from "../icp-store";
import type { Tool } from "../types";
import { runIcpAnalysis, buildCustomerInputs, icpAusText } from "../../discovery/icp-assistant";
import type { AttachmentStore, StagedAttachment } from "../attachment-store";
import { domainFromUrl } from "../../discovery/scan";
import { fillProfileFromIcp } from "../icp-profile-sync";
import type { CustomerProfileStore } from "../../discovery/customer-profiles";
import type { UserProfileStore } from "../profile-store";

export interface IcpToolDeps {
  icp: IcpStore;
  gateway: GatewayClient;
  providers: LlmProviderManager;
  customerStore: CustomerProfileStore;
  /** ICP→Profil-Bruecke: leere Profil-Felder aus dem ICP ergaenzen. */
  profile: UserProfileStore;
  /** Hochgeladene Dateien der Unterhaltung (fuer icp_aus_dokument). */
  attachments?: AttachmentStore;
  /** Fokus-Themen angelegt? (docs/PLAN_THEMEN.md: nach dem ICP Themen vorschlagen) */
  themenAnzahl?: () => number;
}

function textVonDatei(d: StagedAttachment): string {
  if (d.seiten && d.seiten.length > 0) return d.seiten.join("\n\n");
  return "";
}

export function buildIcpTools(deps: IcpToolDeps): Tool[] {
  const get = defineTool({
    name: "icp_get",
    summary:
      "Idealkundenprofil (ICP) des Nutzers lesen — Grundlage fuer Firmen-Discovery-Matches.",
    category: "icp idealkunden discovery",
    description:
      "Liest das gespeicherte Idealkundenprofil (ICP): Freitext-Beschreibung, " +
      "Branchen, Heimat-Orte + Radius, Groessen-Praeferenz, Ausschluesse. " +
      "Das ICP bleibt lokal auf der Nutzer-Maschine.",
    parameters: { type: "object", properties: {} },
    schema: yup.object({}),
    preview: () => "ICP gelesen",
    run: async () => {
      const p = deps.icp.get();
      return { ...p, gesetzt: deps.icp.isSet() };
    },
  });

  const set = defineTool({
    name: "icp_set",
    summary:
      "Idealkundenprofil (ICP) speichern/aktualisieren — IMMER aufrufen, wenn der Nutzer beschreibt, welche Firmen seine idealen Kunden sind.",
    category: "icp idealkunden discovery",
    description:
      "Speichert das Idealkundenprofil (Patch — nur uebergebene Felder " +
      "aendern sich). Rufe dieses Tool auf, wenn der Nutzer sein ICP " +
      "beschreibt oder die ICP-Frage aus der Begruessung beantwortet " +
      "(Branche, Groesse, Region). beschreibung = Freitext in den Worten " +
      "des Nutzers; branchen/orte strukturiert dazu. KEINE Vermutungen " +
      "speichern — nur, was der Nutzer gesagt hat.",
    parameters: {
      type: "object",
      properties: {
        beschreibung: { type: "string", description: "Freitext-ICP (max 2000 Zeichen)." },
        angebot: { type: "string", description: "Eigenes Angebot (Produkte/Leistungen)." },
        nutzen: { type: "string", description: "Geloestes Problem / Nutzenversprechen." },
        branchen: { type: "array", items: { type: "string" }, description: "Max 12." },
        orte: { type: "array", items: { type: "string" }, description: "Heimat-Orte fuer den Radar, max 5. Orte ausserhalb Deutschlands mit Landkuerzel: \"Wien (AT)\", \"Zürich (CH)\", \"Manchester (UK)\", \"Oslo (NO)\", \"Helsinki (FI)\"." },
        radiusKm: { type: "integer", description: "Radar-Umkreis (Default 50, max 200)." },
        groesse: { type: "string", description: "Groessen-Praeferenz, z. B. '10-200 Mitarbeiter'." },
        merkmale: { type: "array", items: { type: "string" }, description: "Weitere Merkmale idealer Kunden, max 10." },
        ausschluesse: { type: "string", description: "Harte Ausschluesse, z. B. 'keine Agenturen'." },
      },
    },
    schema: yup.object({
      beschreibung: yup.string().trim().max(2000).optional(),
      angebot: yup.string().trim().max(600).optional(),
      nutzen: yup.string().trim().max(600).optional(),
      branchen: yup.array().of(yup.string().trim().min(2).max(60).required()).max(12).optional(),
      orte: yup.array().of(yup.string().trim().min(2).max(80).required()).max(5).optional(),
      radiusKm: yup.number().integer().min(1).max(200).optional(),
      groesse: yup.string().trim().max(200).optional(),
      merkmale: yup.array().of(yup.string().trim().min(2).max(120).required()).max(10).optional(),
      ausschluesse: yup.string().trim().max(500).optional(),
    }),
    preview: () => "ICP aktualisiert",
    run: async (args) => {
      const merged = deps.icp.set({ ...args, quelle: "chat" });
      // v0.1.521 — Profil-Felder (Bio/Branchen/Regionen) mitziehen:
      // leere und unveraendert ICP-abgeleitete werden ersetzt, vom
      // Nutzer bearbeitete bleiben unangetastet (werden gemeldet).
      const sync = fillProfileFromIcp(deps.profile, merged);
      const hinweise: string[] = [];
      if (sync.aktualisiert.length > 0) {
        hinweise.push(`Nutzerprofil aktualisiert: ${sync.aktualisiert.join(", ")}.`);
      }
      if (sync.beibehalten.length > 0) {
        hinweise.push(
          `Beibehalten, weil vom Nutzer selbst bearbeitet: ${sync.beibehalten.join(", ")} — auf Wunsch per profile_update ueberschreiben.`,
        );
      }
      const fehlt = deps.icp.fehlendeFelder();
      if (fehlt.length > 0) {
        hinweise.push(
          `Fuer den Firmen-Radar fehlt noch: ${fehlt.join("; ")}. Frag den Nutzer danach, bevor du einen Scan startest.`,
        );
      }
      if (fehlt.length === 0 && (deps.themenAnzahl?.() ?? 0) === 0) {
        hinweise.push(
          "Fokus-Themen: Der Nutzer hat noch keine. Schlag ihm aus Angebot und Nutzen zwei bis drei Fokus-Themen vor (wonach AVA auf jeder Firmen-Website zusaetzlich sucht, z. B. ein Produktthema oder eine Zertifizierung) und lege sie nach Bestaetigung mit themen_set an.",
        );
      }
      return {
        gespeichert: true,
        vollstaendig: fehlt.length === 0,
        ...(fehlt.length > 0 ? { fehlend: fehlt } : {}),
        icp: merged,
        ...(sync.aktualisiert.length > 0 ? { profilErgaenzt: sync.aktualisiert } : {}),
        ...(sync.beibehalten.length > 0 ? { profilBeibehalten: sync.beibehalten } : {}),
        ...(hinweise.length > 0 ? { hinweis: hinweise.join(" ") } : {}),
      };
    },
  });

  // Dritter Weg (2026-10-14): bestehendes ICP aus Dokument oder Freitext verdichten.
  const ausDokument = defineTool({
    name: "icp_aus_dokument",
    summary:
      "Bestehendes Idealkundenprofil aus einem Dokument (hochgeladene PDF/Word-Datei) oder eingefuegtem Text in das ICP-Formular verdichten (Entwurf, KEIN Speichern).",
    category: "icp idealkunden assistent dokument import discovery",
    description:
      "Wenn der Nutzer sein ICP schon beschrieben hat (Confluence-Export, Word, PDF, langer Text): " +
      "liest das Dokument EINMAL und verdichtet es in die Formularfelder (Angebot, Nutzen, Branchen, " +
      "Orte, Groesse, Merkmale, Ausschluesse, Beispielkunden, Beschreibung). Entweder `datei` " +
      "(Name oder Handle einer hochgeladenen Datei) oder `text` angeben. Dauert bei langen Dokumenten " +
      "1-2 Minuten. WICHTIG: Ergebnis ist NUR ein Entwurf — zeige ihn dem Nutzer kompakt, nenne die " +
      "nicht belegten Felder und speichere erst nach Bestaetigung via icp_set. Das Dokument bleibt lokal.",
    parameters: {
      type: "object",
      properties: {
        datei: { type: "string", description: "Dateiname oder Handle einer hochgeladenen Datei (PDF, DOCX, TXT)." },
        text: { type: "string", description: "Das ICP als Text, wenn keine Datei vorliegt." },
      },
    },
    schema: yup.object({
      datei: yup.string().trim().min(1).max(200).optional(),
      text: yup.string().trim().min(80).max(200_000).optional(),
    }),
    preview: (r) => {
      const res = r as { error?: string; fehlend?: string[]; abschnitte?: number };
      if (res.error) return res.error;
      return `ICP-Entwurf aus Dokument (${res.abschnitte ?? 1} Abschnitt${(res.abschnitte ?? 1) === 1 ? "" : "e"}${res.fehlend?.length ? `, offen: ${res.fehlend.join(", ")}` : ""})`;
    },
    run: async (args, ctx) => {
      let text = args.text ?? "";
      let quelle = "eingefuegter Text";
      if (args.datei) {
        if (!deps.attachments) return { error: "Dateien stehen hier nicht zur Verfuegung." };
        const r = deps.attachments.aufloesen(ctx.conversationId, args.datei);
        if ("fehler" in r) return { error: r.fehler, kandidaten: r.kandidaten };
        text = textVonDatei(r.datei);
        quelle = r.datei.filename;
        if (text.trim().length < 80) return { error: `"${r.datei.filename}" enthaelt keinen lesbaren Text.` };
      }
      if (text.trim().length < 80) return { error: "Bitte `datei` oder `text` (mindestens 80 Zeichen) angeben." };
      const result = await icpAusText(deps.providers, { text, quelle }, (p) => ctx.log(`icp_aus_dokument: ${p.text} (${p.step}/${p.total})`));
      if ("error" in result) return { error: result.error };
      return {
        entwurf: result.icp,
        fehlend: result.fehlend,
        hinweise: result.hinweise,
        quelle,
        abschnitte: result.abschnitte,
        zeichen: result.zeichen,
        naechsterSchritt: "Entwurf dem Nutzer kompakt zeigen; nach Bestaetigung mit icp_set speichern.",
      };
    },
  });

  const assist = defineTool({
    name: "icp_assist_from_urls",
    summary:
      "ICP-Entwurf automatisch aus der eigenen Website + Kunden-Websites erstellen (Analyse, KEIN Speichern).",
    category: "icp idealkunden assistent discovery",
    description:
      "Analysiert die eigene Website des Nutzers (Angebot, Nutzen, " +
      "Standort aus dem Impressum) und bis zu 5 Websites seiner besten " +
      "Bestandskunden (Branche, Groesse, Standort) und erstellt daraus " +
      "einen ICP-Entwurf inkl. Radius-Vorschlag aus den realen " +
      "Kunden-Distanzen. Dauert 1-3 Minuten. WICHTIG: Das Ergebnis ist " +
      "NUR ein Entwurf — praesentiere ihn dem Nutzer uebersichtlich und " +
      "speichere erst nach dessen Bestaetigung via icp_set. Kunden-Daten " +
      "bleiben lokal.",
    parameters: {
      type: "object",
      required: ["eigeneUrl"],
      properties: {
        eigeneUrl: { type: "string", description: "Website des Nutzers." },
        kundenUrls: {
          type: "array",
          items: { type: "string" },
          description: "Websites der besten Bestandskunden, max 5.",
        },
      },
    },
    schema: yup.object({
      eigeneUrl: yup.string().trim().min(4).max(300).required(),
      kundenUrls: yup
        .array()
        .of(yup.string().trim().min(4).max(300).required())
        .max(5)
        .optional(),
    }),
    preview: (r) => {
      const res = r as {
        error?: string;
        kundenBeruecksichtigt?: string[];
        kundenFehlgeschlagen?: unknown[];
      };
      if (res.error) return res.error;
      const ok = res.kundenBeruecksichtigt?.length ?? 0;
      const bad = res.kundenFehlgeschlagen?.length ?? 0;
      return `ICP-Entwurf erstellt (${ok} Kunden eingeflossen${bad > 0 ? `, ${bad} fehlgeschlagen` : ""})`;
    },
    run: async (args) => {
      const eigeneDomain = domainFromUrl(args.eigeneUrl);
      if (!eigeneDomain) {
        return { error: "Die eigene Website-URL ist nicht verwertbar." };
      }
      const { inputs: kunden, unbrauchbar } = buildCustomerInputs(
        args.kundenUrls ?? [],
        eigeneDomain,
      );
      const result = await runIcpAnalysis(
        deps.gateway,
        deps.providers,
        { eigeneDomain, kunden },
        () => {
          /* Chat-Pfad: kein Fortschritts-Stream noetig */
        },
        deps.customerStore,
      );
      if ("error" in result) return result;
      return {
        hinweisFuerAgent:
          "ENTWURF — dem Nutzer zusammengefasst zeigen (inkl. NICHT eingeflossener Kunden!) und erst nach Bestaetigung via icp_set speichern (Felder 1:1 uebernehmen).",
        entwurf: result.icp,
        radiusBegruendung: result.radiusBegruendung,
        kundenBeruecksichtigt: result.kunden.map((k) => `${k.name} (${k.domain})`),
        kundenFehlgeschlagen: result.kundenFehlgeschlagen,
        unbrauchbareUrls: unbrauchbar,
        hinweise: result.hinweise,
      };
    },
  });

  return [get, set, assist, ausDokument];
}
