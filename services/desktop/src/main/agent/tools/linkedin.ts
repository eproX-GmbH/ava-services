// Phase T1 — LinkedIn agent tools.
//
// Thin wrappers around the same main-process helpers that the
// `linkedin:*` IPC handlers call. The agent can drive first-time setup
// or troubleshoot a stuck monitor without making the user hunt for
// Settings → LinkedIn.
//
// IMPORTANT — by design we do NOT expose `linkedin:consent:accept`
// or `linkedin:consent:revoke` as agent tools. Consent is a
// user-must-read-it action and stays UI-only: the user reads the
// consent text on screen and clicks. Letting the chat agent flip
// the consent flag would defeat the compliance gate.
//
// All tools resolve quickly (no IPC dependency that requires an
// active renderer). `linkedin_connect` opens a BrowserWindow and
// waits up to 5 minutes — that's the user's flow, not a hang.

import * as yup from "yup";
import { BrowserWindow } from "electron";
import { defineTool } from "../define-tool";
import type { Tool } from "../types";
import {
  clearStoredSession,
  hasStoredSession,
  readStoredMeta,
} from "../../linkedin/session";
import { runLoginFlow } from "../../linkedin/login-window";
import { cancelActiveScan } from "../../linkedin/scraper";
import { cancelDrain as cancelExtractorDrain } from "../../linkedin/extractor";
import {
  read as readSettings,
  reset as resetSettings,
  write as writeSettings,
} from "../../linkedin/store";
import { generateFingerprint } from "../../linkedin/fingerprint";

function ensureFingerprintAfterReset(): void {
  const current = readSettings();
  if (!current.fingerprint) {
    writeSettings({ fingerprint: generateFingerprint() });
  }
}

export function buildLinkedInTools(): Tool[] {
  const statusTool = defineTool({
    name: "linkedin_status",
    description:
      "Liest den Verbindungsstatus des LinkedIn-Beobachters: ob ein Login vorhanden ist, " +
      "wann die Sitzung erfasst wurde, die member-URN und ob der Kill-Switch aktiv ist. " +
      "Nutze das Tool, wenn der Nutzer fragt, ob LinkedIn verbunden ist oder warum der " +
      "Monitor nichts tut.",
    parameters: {
      type: "object",
      properties: {},
    },
    schema: yup.object({}),
    run: async () => {
      const meta = readStoredMeta();
      const connected = hasStoredSession() && meta !== null;
      const settings = readSettings();
      return {
        connected,
        memberUrn: meta?.memberUrn ?? null,
        capturedAt: meta?.capturedAt ?? null,
        earliestExpiresAt: meta?.earliestExpiresAt ?? null,
        killSwitchEngaged: settings.enabled === false && meta === null,
        monitorEnabled: settings.enabled === true,
        consentAcceptedAt: settings.consentAcceptedAt,
      };
    },
    preview: (r) =>
      r.connected
        ? `LinkedIn verbunden${r.memberUrn ? ` (${r.memberUrn})` : ""}`
        : "LinkedIn nicht verbunden",
  });

  const connectTool = defineTool({
    name: "linkedin_connect",
    description:
      "Öffnet das LinkedIn-Login-Fenster, damit der Nutzer die Sitzungs-Cookies erfassen " +
      "kann. Verwende das Tool, wenn der Nutzer LinkedIn neu verbinden, die Verbindung " +
      "wiederherstellen oder den Beobachter erstmals einrichten möchte. " +
      "Das Tool wartet, bis der Nutzer den Login abgeschlossen oder das Fenster geschlossen hat.",
    parameters: {
      type: "object",
      properties: {},
    },
    schema: yup.object({}),
    run: async () => {
      const settings = readSettings();
      if (!settings.consentAcceptedAt) {
        return {
          ok: false,
          reason: "consent_required" as const,
          message:
            "Bevor LinkedIn verbunden werden kann, muss die Einwilligung in den Einstellungen " +
            "akzeptiert werden. Bitte zu Einstellungen → LinkedIn wechseln.",
        };
      }
      const parent = BrowserWindow.getFocusedWindow();
      const result = await runLoginFlow(parent);
      if (result.ok) {
        return { ok: true as const, meta: result.meta };
      }
      return { ok: false as const, reason: result.reason };
    },
    preview: (r) => (r.ok ? "LinkedIn-Login erfolgreich" : `LinkedIn-Login abgebrochen (${r.reason})`),
  });

  const disconnectTool = defineTool({
    name: "linkedin_disconnect",
    description:
      "Trennt die LinkedIn-Verbindung, indem die gespeicherten Cookies vergessen werden. " +
      "Der Beobachter bleibt konfiguriert; der Nutzer kann sich später per `linkedin_connect` " +
      "neu anmelden.",
    parameters: {
      type: "object",
      properties: {},
    },
    schema: yup.object({}),
    run: async () => {
      clearStoredSession();
      return { ok: true as const };
    },
    preview: () => "LinkedIn getrennt",
  });

  const scanCancelTool = defineTool({
    name: "linkedin_scan_cancel",
    description:
      "Bricht einen laufenden LinkedIn-Scan ab. Sinnvoll, wenn der Scan hängt oder der " +
      "Nutzer die Aktion stoppen möchte.",
    parameters: {
      type: "object",
      properties: {},
    },
    schema: yup.object({}),
    run: async () => {
      cancelActiveScan();
      return { cancelled: true };
    },
    preview: () => "LinkedIn-Scan abgebrochen",
  });

  const signalsCancelTool = defineTool({
    name: "linkedin_signals_cancel",
    description:
      "Bricht die laufende LinkedIn-Signal-Extraktion ab. Verwende das Tool, wenn der " +
      "Nutzer die KI-Auswertung der gescrapten Posts stoppen möchte.",
    parameters: {
      type: "object",
      properties: {},
    },
    schema: yup.object({}),
    run: async () => {
      cancelExtractorDrain();
      return { cancelled: true };
    },
    preview: () => "Signal-Extraktion abgebrochen",
  });

  const killSwitchTool = defineTool({
    name: "linkedin_killswitch",
    description:
      "Notfall-Stopp des kompletten LinkedIn-Beobachters: vergisst alle Cookies, Posts, " +
      "Signale und Einstellungen unter userData/linkedin/. Verwende das Tool nur, wenn " +
      "der Nutzer ausdrücklich 'alles vergessen' oder 'Kill-Switch' verlangt. " +
      "Nach dem Aufruf ist eine komplette Neueinrichtung nötig.",
    parameters: {
      type: "object",
      properties: {},
    },
    schema: yup.object({}),
    run: async () => {
      resetSettings();
      ensureFingerprintAfterReset();
      return { engaged: true };
    },
    preview: () => "LinkedIn-Kill-Switch ausgelöst",
  });

  return [
    statusTool,
    connectTool,
    disconnectTool,
    scanCancelTool,
    signalsCancelTool,
    killSwitchTool,
  ];
}
