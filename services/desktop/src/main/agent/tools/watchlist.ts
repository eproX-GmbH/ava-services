// WL4 — Chat-Tools der Personen-Watchlist (PLAN_LINKEDIN_WATCHLIST.md §4.5).
//
// add/set_fokus sind Klasse-A-Aktionen (legen Neues an / markieren) →
// confirmAction "additive": mit Vollmacht Halb-auto laufen sie ohne
// Rueckfrage, auch aus Telegram. remove fragt immer interaktiv nach
// (Buerste gegen versehentliches Abraeumen), ist aber NICHT destruktiv
// im Sinne der Klasse C (nur lokale Liste).

import * as yup from "yup";
import { defineTool, userDeclined } from "../define-tool";
import type { Tool } from "../types";
import type { WatchlistStore } from "../../linkedin/watchlist/store";
import type { WatchlistSupervisor } from "../../linkedin/watchlist/supervisor";
import type { WatchlistKeyStore } from "../../linkedin/watchlist/key-store";

export interface WatchlistToolDeps {
  /** Lazy — Stores entstehen erst im App-Boot nach dem Registry-Build. */
  getStore: () => WatchlistStore | null;
  getSupervisor: () => WatchlistSupervisor | null;
  getKeyStore: () => WatchlistKeyStore | null;
  /** v0.1.490 — companyWindow-Aenderung recycelt den company-contact-
   *  Producer (frisches APIFY_COMPANY_FENSTER-env). */
  onCompanyWindowChanged?: () => void;
}

export function buildWatchlistTools(deps: WatchlistToolDeps): Tool[] {
  const add = defineTool({
    name: "linkedin_watchlist_add",
    summary:
      "Person auf die LinkedIn-Watchlist setzen (Profil-URL noetig; optional Fokus + Firmen-Zuordnung).",
    category: "linkedin watchlist kontakte",
    description:
      "Setzt eine Person auf die LinkedIn-Personen-Watchlist: ihre " +
      "oeffentliche Aktivitaet (Reaktionen/Kommentare) wird regelmaessig " +
      "geprueft und relevante Signale werden gemeldet. Braucht die " +
      "LinkedIn-Profil-URL (linkedin.com/in/…) — falls unbekannt, erst " +
      "contact_linkedin_lookup. fokus=true prueft die Person bei JEDEM " +
      "Lauf und meldet mindestens mit 'warn' (Telegram). companyId " +
      "verknuepft Meldungen direkt mit der Firma.",
    parameters: {
      type: "object",
      required: ["profileUrl", "label"],
      properties: {
        profileUrl: { type: "string", description: "LinkedIn-Profil-URL (…/in/<slug>)." },
        label: { type: "string", description: "Anzeigename (z. B. 'Nils Frohloff')." },
        companyId: { type: "string", description: "Optional: AVA-companyId der Firma." },
        fokus: { type: "boolean", description: "Fokus-Person (jeden Lauf, Alerts mind. warn)." },
      },
    },
    schema: yup
      .object({
        profileUrl: yup.string().trim().min(10).required(),
        label: yup.string().trim().min(2).max(200).required(),
        companyId: yup.string().trim().optional(),
        fokus: yup.boolean().optional(),
      })
      .noUnknown(true),
    preview: (r) => {
      const res = r as { error?: string; profileUrl?: string };
      return res.error ?? `Auf der Watchlist: ${res.profileUrl}`;
    },
    run: async (args, c) => {
      const store = deps.getStore();
      if (!store) return { error: "Watchlist nicht initialisiert." };
      const value = await c.ui.confirmAction(
        {
          kind: "additive",
          prompt:
            `${args.label} auf die LinkedIn-Watchlist setzen?\n\n${args.profileUrl}` +
            (args.fokus ? "\nAls FOKUS-Person (jeden Lauf, Meldungen mind. warn)." : ""),
          confirmValue: "add",
          options: [
            { value: "add", label: "Aufnehmen" },
            { value: "cancel", label: "Verwerfen" },
          ],
        },
        c.signal,
      );
      if (value !== "add") return userDeclined();
      return store.add({
        profileUrl: args.profileUrl,
        label: args.label,
        companyId: args.companyId ?? null,
        fokus: args.fokus,
        quelle: "manuell",
      });
    },
  });

  const list = defineTool({
    name: "linkedin_watchlist_list",
    summary: "LinkedIn-Watchlist anzeigen (Eintraege, Fokus, letzte Sichtung).",
    category: "linkedin watchlist",
    description:
      "Listet die LinkedIn-Personen-Watchlist: wer wird beobachtet, wer " +
      "ist Fokus-Person, wann war die letzte Pruefung. Dazu Status der " +
      "Automatik (lastOutcome).",
    parameters: { type: "object", properties: {} },
    schema: yup.object({}),
    preview: (r) => {
      const res = r as { eintraege?: unknown[] };
      return `${res.eintraege?.length ?? 0} Eintraege`;
    },
    run: async () => {
      const store = deps.getStore();
      if (!store) return { error: "Watchlist nicht initialisiert." };
      const cfg = deps.getKeyStore()?.getConfig();
      return {
        eintraege: await store.list(),
        automatik: cfg
          ? {
              enabled: cfg.enabled,
              intervalHours: cfg.intervalHours,
              lastRunAt: cfg.lastRunAt,
              lastOutcome: cfg.lastOutcome,
            }
          : null,
      };
    },
  });

  const setFokus = defineTool({
    name: "linkedin_watchlist_set_fokus",
    summary: "Fokus-Flag einer Watchlist-Person setzen/entfernen.",
    category: "linkedin watchlist",
    description:
      "Markiert eine Watchlist-Person als Fokus (jeden Lauf gecheckt, " +
      "Meldungen mind. 'warn') oder nimmt den Fokus zurueck. Fokus-" +
      "Plaetze sind je Plan begrenzt.",
    parameters: {
      type: "object",
      required: ["profileUrl", "fokus"],
      properties: {
        profileUrl: { type: "string" },
        fokus: { type: "boolean" },
      },
    },
    schema: yup
      .object({
        profileUrl: yup.string().trim().min(10).required(),
        fokus: yup.boolean().required(),
      })
      .noUnknown(true),
    preview: (r) => {
      const res = r as { error?: string; ok?: boolean };
      return res.error ?? (res.ok ? "Fokus aktualisiert" : "Eintrag nicht gefunden");
    },
    run: async (args, c) => {
      const store = deps.getStore();
      if (!store) return { error: "Watchlist nicht initialisiert." };
      const value = await c.ui.confirmAction(
        {
          kind: "additive",
          prompt: `${args.profileUrl}\nFokus ${args.fokus ? "SETZEN" : "entfernen"}?`,
          confirmValue: "ok",
          options: [
            { value: "ok", label: args.fokus ? "Fokus setzen" : "Fokus entfernen" },
            { value: "cancel", label: "Abbrechen" },
          ],
        },
        c.signal,
      );
      if (value !== "ok") return userDeclined();
      const r = await store.setFokus(args.profileUrl, args.fokus);
      if (typeof r === "object") return r;
      return { ok: r };
    },
  });

  const remove = defineTool({
    name: "linkedin_watchlist_remove",
    summary: "Person von der LinkedIn-Watchlist nehmen.",
    category: "linkedin watchlist",
    description:
      "Entfernt eine Person von der Watchlist (Beobachtung endet; die " +
      "Sichtungs-Historie verfaellt nach TTL von selbst).",
    parameters: {
      type: "object",
      required: ["profileUrl"],
      properties: { profileUrl: { type: "string" } },
    },
    schema: yup
      .object({ profileUrl: yup.string().trim().min(10).required() })
      .noUnknown(true),
    preview: (r) => {
      const res = r as { entfernt?: boolean };
      return res.entfernt ? "Entfernt" : "Nicht gefunden";
    },
    run: async (args, c) => {
      const store = deps.getStore();
      if (!store) return { error: "Watchlist nicht initialisiert." };
      const value = await c.ui.askChoice(
        `${args.profileUrl} von der Watchlist entfernen?`,
        [
          { value: "remove", label: "Entfernen" },
          { value: "cancel", label: "Behalten" },
        ],
        c.signal,
      );
      if (value !== "remove") return userDeclined();
      return { entfernt: await store.remove(args.profileUrl) };
    },
  });

  const checkNow = defineTool({
    name: "linkedin_watchlist_check_now",
    summary: "Watchlist sofort pruefen (kostet Anbieter-Items).",
    category: "linkedin watchlist",
    description:
      "Stoesst einen sofortigen Watchlist-Lauf an (Fokus-Personen zuerst). " +
      "Kostet Items beim Scraping-Anbieter (BYOK — der Nutzer zahlt). " +
      "Ergebnis ist die Lauf-Zusammenfassung; neue Signale kommen als " +
      "Meldungen (Glocke/Telegram).",
    parameters: { type: "object", properties: {} },
    schema: yup.object({}),
    preview: (r) => String(r).slice(0, 80),
    run: async (_args, c) => {
      const sup = deps.getSupervisor();
      if (!sup) return "Watchlist nicht initialisiert.";
      const value = await c.ui.confirmAction(
        {
          kind: "additive",
          prompt:
            "Watchlist jetzt pruefen? Das ruft den Scraping-Anbieter auf und kostet Items (dein Apify-Guthaben).",
          confirmValue: "run",
          options: [
            { value: "run", label: "Jetzt pruefen" },
            { value: "cancel", label: "Abbrechen" },
          ],
        },
        c.signal,
      );
      if (value !== "run") return userDeclined();
      return sup.runNow("manuell");
    },
  });

  // v0.1.490 — Self-Service im Chat: Watchlist-Konfiguration lesen und
  // aendern. Der Apify-TOKEN selbst wird NIE per Chat gesetzt.
  const config = defineTool({
    name: "linkedin_watchlist_config",
    summary:
      "Watchlist-Einstellungen anzeigen oder aendern (Automatik, Intervall, Items/Person, Bestands-Rotation, Kontakt-Suchfenster).",
    category: "linkedin watchlist einstellungen",
    description:
      "Ohne Parameter: aktuelle Watchlist-Konfiguration inkl. " +
      "Monats-Verbrauch. Mit Parametern: Einstellungen aendern " +
      "(Wirkungsklasse mutating — fragt je nach Vollmacht nach). " +
      "companyWindow steuert, wie viele Profile die Kontakt-Verarbeitung " +
      "je Firma vom LinkedIn-Firmenprofil zieht (Short-Mode, 4 $ je " +
      "1.000 Profile — der Nutzer zahlt). Der Apify-Token selbst kann " +
      "NUR im Signale-Panel gesetzt werden, nie per Chat.",
    parameters: {
      type: "object",
      properties: {
        automatik: { type: "boolean", description: "Automatische Laeufe an/aus (braucht hinterlegten Token)." },
        intervalHours: { type: "number", enum: [24, 168], description: "Pruef-Intervall: 24 = taeglich, 168 = woechentlich." },
        maxItemsPerProfile: { type: "number", description: "Item-Budget je Person und Lauf (1-100)." },
        bestandRotationEnabled: { type: "boolean", description: "Bestands-Rotation an/aus." },
        maxBestandPerRun: { type: "number", description: "Rotierte Bestands-Kontakte je Lauf (1-50)." },
        companyWindow: { type: "number", description: "Kontakt-Suchfenster je Firma (25-1000 Profile)." },
      },
    },
    schema: yup.object({
      automatik: yup.boolean().optional(),
      intervalHours: yup.number().oneOf([24, 168]).optional(),
      maxItemsPerProfile: yup.number().min(1).max(100).optional(),
      bestandRotationEnabled: yup.boolean().optional(),
      maxBestandPerRun: yup.number().min(1).max(50).optional(),
      companyWindow: yup.number().min(25).max(1000).optional(),
    }),
    preview: (r) => JSON.stringify(r).slice(0, 80),
    run: async (args, c) => {
      const ks = deps.getKeyStore();
      if (!ks) return "Watchlist nicht initialisiert.";
      const patch: Record<string, unknown> = {};
      if (args.automatik !== undefined) patch.enabled = args.automatik === true;
      for (const k of [
        "intervalHours",
        "maxItemsPerProfile",
        "bestandRotationEnabled",
        "maxBestandPerRun",
        "companyWindow",
      ] as const) {
        if (args[k] !== undefined) patch[k] = args[k];
      }
      const vorher = ks.getConfig();
      if (Object.keys(patch).length === 0) {
        return {
          automatik: vorher.enabled,
          tokenHinterlegt: ks.hasKey(),
          intervalHours: vorher.intervalHours,
          maxItemsPerProfile: vorher.maxItemsPerProfile,
          bestandRotationEnabled: vorher.bestandRotationEnabled,
          maxBestandPerRun: vorher.maxBestandPerRun,
          companyWindow: vorher.companyWindow,
          monatsVerbrauchItems: vorher.monthItems,
          hinweis:
            "companyWindow kostet im Extremfall (companyWindow x 4 $ / 1000) je Firmenlauf.",
        };
      }
      if (patch.enabled === true && !ks.hasKey()) {
        return "Automatik braucht einen hinterlegten Apify-Token — bitte im Signale-Panel setzen (Tokens gehen nie ueber den Chat).";
      }
      const beschreibung = Object.entries(patch)
        .map(([k, v]) => `${k} → ${String(v)}`)
        .join(", ");
      const kostenHinweis =
        typeof patch.companyWindow === "number"
          ? ` Achtung: ${patch.companyWindow} Profile kosten im Extremfall ~${((patch.companyWindow * 4) / 1000).toFixed(2)} $ je Firmenlauf.`
          : "";
      const value = await c.ui.confirmAction(
        {
          kind: "mutating",
          prompt: `Watchlist-Einstellungen aendern: ${beschreibung}?${kostenHinweis}`,
          confirmValue: "save",
          options: [
            { value: "save", label: "Aendern" },
            { value: "cancel", label: "Abbrechen" },
          ],
        },
        c.signal,
      );
      if (value !== "save") return userDeclined();
      const nach = ks.setConfig(patch);
      if (
        typeof patch.companyWindow === "number" &&
        nach.companyWindow !== vorher.companyWindow
      ) {
        deps.onCompanyWindowChanged?.();
      }
      return {
        gespeichert: true,
        automatik: nach.enabled,
        intervalHours: nach.intervalHours,
        maxItemsPerProfile: nach.maxItemsPerProfile,
        bestandRotationEnabled: nach.bestandRotationEnabled,
        maxBestandPerRun: nach.maxBestandPerRun,
        companyWindow: nach.companyWindow,
      };
    },
  });

  return [add, list, setFokus, remove, checkNow, config];
}
