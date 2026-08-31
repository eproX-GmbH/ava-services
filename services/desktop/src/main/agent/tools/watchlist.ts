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

  return [add, list, setFokus, remove, checkNow];
}
