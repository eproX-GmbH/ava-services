// v0.1.490 — Self-Service im Chat fuer die juengeren LinkedIn-Features
// (User-Anweisung 2026-08-31: alles per Chat einstellbar).
//
//   personen_radar_config     — Konfiguration lesen/aendern inkl. Post-URLs
//   personen_radar_check_now  — sofortiger Lauf (kostet Apify-Guthaben)
//   linkedin_beobachter       — Feed-Beobachter Status / an / aus
//
// Grenzen bleiben hart: API-Tokens gehen NIE ueber den Chat, und das
// ERSTMALIGE Aktivieren des Feed-Beobachters braucht das Consent-Modal
// in der UI (hartes Opt-in) — per Chat nur, wenn der Consent frueher
// schon erteilt wurde (Zeitstempel vorhanden).

import * as yup from "yup";
import { defineTool, userDeclined } from "../define-tool";
import type { Tool } from "../types";
import type { PersonenRadarStore } from "../../linkedin/personen-radar/store";
import type { PersonenRadarSupervisor } from "../../linkedin/personen-radar/supervisor";
import { read as readLinkedInSettings, write as writeLinkedInSettings } from "../../linkedin/store";

export interface LinkedInSelfserviceDeps {
  getPradarStore: () => PersonenRadarStore | null;
  getPradarSupervisor: () => PersonenRadarSupervisor | null;
}

export function buildLinkedInSelfserviceTools(
  deps: LinkedInSelfserviceDeps,
): Tool[] {
  const pradarConfig = defineTool({
    name: "personen_radar_config",
    summary:
      "Personen-Radar-Einstellungen anzeigen oder aendern (Post-URLs, Automatik, Intervall, Budgets).",
    category: "linkedin personen-radar einstellungen",
    description:
      "Ohne Parameter: aktuelle Personen-Radar-Konfiguration. Mit " +
      "Parametern: Einstellungen aendern (Wirkungsklasse mutating). " +
      "addPostUrls/removePostUrls pflegen die beobachteten " +
      "LinkedIn-Post-URLs (max. 25). maxResolvesPerRun ist der " +
      "teuerste Hebel (Profil-Aufloesungen, 4 $ je 1.000 beim " +
      "Apify-Anbieter — der Nutzer zahlt).",
    parameters: {
      type: "object",
      properties: {
        automatik: { type: "boolean", description: "Automatische Laeufe an/aus." },
        intervalHours: { type: "number", enum: [24, 168], description: "24 = taeglich, 168 = woechentlich." },
        maxItemsPerPost: { type: "number", description: "Engagement-Items je Post (1-200)." },
        maxResolvesPerRun: { type: "number", description: "Profil-Aufloesungen je Lauf (1-50) — Kosten-Hebel." },
        addPostUrls: { type: "array", items: { type: "string" }, description: "LinkedIn-Post-URLs hinzufuegen." },
        removePostUrls: { type: "array", items: { type: "string" }, description: "Post-URLs entfernen." },
      },
    },
    schema: yup.object({
      automatik: yup.boolean().optional(),
      intervalHours: yup.number().oneOf([24, 168]).optional(),
      maxItemsPerPost: yup.number().min(1).max(200).optional(),
      maxResolvesPerRun: yup.number().min(1).max(50).optional(),
      addPostUrls: yup.array().of(yup.string().required()).optional(),
      removePostUrls: yup.array().of(yup.string().required()).optional(),
    }),
    preview: (r) => JSON.stringify(r).slice(0, 80),
    run: async (args, c) => {
      const store = deps.getPradarStore();
      if (!store) return "Personen-Radar nicht initialisiert.";
      const vorher = store.getConfig();

      const aenderungen: string[] = [];
      const patch: Record<string, unknown> = {};
      if (args.automatik !== undefined) {
        patch.enabled = args.automatik === true;
        aenderungen.push(`Automatik → ${args.automatik ? "an" : "aus"}`);
      }
      if (args.intervalHours !== undefined) {
        patch.intervalHours = args.intervalHours;
        aenderungen.push(`Intervall → ${args.intervalHours}h`);
      }
      if (args.maxItemsPerPost !== undefined) {
        patch.maxItemsPerPost = args.maxItemsPerPost;
        aenderungen.push(`Items/Post → ${args.maxItemsPerPost}`);
      }
      if (args.maxResolvesPerRun !== undefined) {
        patch.maxResolvesPerRun = args.maxResolvesPerRun;
        aenderungen.push(`Aufloesungen/Lauf → ${args.maxResolvesPerRun}`);
      }
      if (
        (args.addPostUrls && args.addPostUrls.length > 0) ||
        (args.removePostUrls && args.removePostUrls.length > 0)
      ) {
        const entfernen = new Set(
          (args.removePostUrls ?? []).map((u) => u.trim()),
        );
        const urls = vorher.postUrls.filter((u) => !entfernen.has(u));
        for (const u of args.addPostUrls ?? []) {
          const t = u.trim();
          if (t && !urls.includes(t)) urls.push(t);
        }
        patch.postUrls = urls.slice(0, 25);
        aenderungen.push(
          `Post-URLs → ${(patch.postUrls as string[]).length} Stueck`,
        );
      }

      if (aenderungen.length === 0) {
        return {
          automatik: vorher.enabled,
          intervalHours: vorher.intervalHours,
          maxItemsPerPost: vorher.maxItemsPerPost,
          maxResolvesPerRun: vorher.maxResolvesPerRun,
          postUrls: vorher.postUrls,
          letzterLauf: vorher.lastRunAt,
          letztesErgebnis: vorher.lastOutcome,
        };
      }

      const value = await c.ui.confirmAction(
        {
          kind: "mutating",
          prompt: `Personen-Radar aendern: ${aenderungen.join(", ")}?`,
          confirmValue: "save",
          options: [
            { value: "save", label: "Aendern" },
            { value: "cancel", label: "Abbrechen" },
          ],
        },
        c.signal,
      );
      if (value !== "save") return userDeclined();
      const nach = store.setConfig(patch);
      return {
        gespeichert: true,
        automatik: nach.enabled,
        intervalHours: nach.intervalHours,
        maxItemsPerPost: nach.maxItemsPerPost,
        maxResolvesPerRun: nach.maxResolvesPerRun,
        postUrls: nach.postUrls,
      };
    },
  });

  const pradarCheckNow = defineTool({
    name: "personen_radar_check_now",
    summary: "Personen-Radar sofort laufen lassen (kostet Apify-Guthaben).",
    category: "linkedin personen-radar",
    description:
      "Stoesst einen sofortigen Personen-Radar-Lauf ueber die " +
      "konfigurierten Post-URLs an. Kostet Apify-Items (BYOK — der " +
      "Nutzer zahlt). Gefundene Firmen erscheinen im Firmen-Radar.",
    parameters: { type: "object", properties: {} },
    schema: yup.object({}),
    preview: (r) => String(r).slice(0, 80),
    run: async (_args, c) => {
      const sup = deps.getPradarSupervisor();
      if (!sup) return "Personen-Radar nicht initialisiert.";
      const value = await c.ui.confirmAction(
        {
          kind: "additive",
          prompt:
            "Personen-Radar jetzt laufen lassen? Das ruft den Scraping-Anbieter auf und kostet Items (dein Apify-Guthaben).",
          confirmValue: "run",
          options: [
            { value: "run", label: "Jetzt laufen lassen" },
            { value: "cancel", label: "Abbrechen" },
          ],
        },
        c.signal,
      );
      if (value !== "run") return userDeclined();
      return sup.runNow("manuell");
    },
  });

  const beobachter = defineTool({
    name: "linkedin_beobachter",
    summary:
      "LinkedIn-Feed-Beobachter: Status abfragen oder an-/ausschalten.",
    category: "linkedin signale einstellungen",
    description:
      "action 'status' zeigt den Zustand. 'aus' deaktiviert den " +
      "Beobachter (Consent bleibt erhalten). 'an' aktiviert ihn — das " +
      "geht per Chat NUR, wenn der Nutzer den Consent frueher schon in " +
      "der UI erteilt hat; sonst muss er einmalig auf der Signale-Seite " +
      "durch das Consent-Modal (hartes Opt-in, nicht delegierbar).",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["status", "an", "aus"] },
      },
      required: ["action"],
    },
    schema: yup.object({
      action: yup.string().oneOf(["status", "an", "aus"]).required(),
    }),
    preview: (r) => JSON.stringify(r).slice(0, 80),
    run: async (args, c) => {
      const cur = readLinkedInSettings();
      if (args.action === "status") {
        return {
          aktiv: cur.enabled === true,
          consentErteilt: cur.consentAcceptedAt != null,
        };
      }
      if (args.action === "an") {
        if (cur.enabled) return { aktiv: true, hinweis: "war schon an" };
        if (!cur.consentAcceptedAt) {
          return (
            "Aktivieren per Chat nicht moeglich: Der Beobachter wurde noch " +
            "nie per Consent freigegeben. Bitte einmalig auf der " +
            "Signale-Seite ueber 'Beobachter aktivieren' zustimmen."
          );
        }
        const value = await c.ui.confirmAction(
          {
            kind: "mutating",
            prompt:
              "LinkedIn-Feed-Beobachter aktivieren? (Consent liegt bereits vor.)",
            confirmValue: "on",
            options: [
              { value: "on", label: "Aktivieren" },
              { value: "cancel", label: "Abbrechen" },
            ],
          },
          c.signal,
        );
        if (value !== "on") return userDeclined();
        const next = writeLinkedInSettings({ enabled: true });
        return { aktiv: next.enabled === true };
      }
      // aus
      if (!cur.enabled) return { aktiv: false, hinweis: "war schon aus" };
      const value = await c.ui.confirmAction(
        {
          kind: "mutating",
          prompt:
            "LinkedIn-Feed-Beobachter deaktivieren? (Consent bleibt erhalten, Wieder-Einschalten geht jederzeit.)",
          confirmValue: "off",
          options: [
            { value: "off", label: "Deaktivieren" },
            { value: "cancel", label: "Abbrechen" },
          ],
        },
        c.signal,
      );
      if (value !== "off") return userDeclined();
      const next = writeLinkedInSettings({ enabled: false });
      return { aktiv: next.enabled === true };
    },
  });

  return [pradarConfig, pradarCheckNow, beobachter];
}
