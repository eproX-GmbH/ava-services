// v0.1.491 — Mail-Triage-Einstellungen (Self-Service im Chat).
//
// THREAD_CONTEXT_LIMIT war seit v0.1.461 hartkodiert (10) mit dem
// User-Wunsch "ggf. auch konfigurierbar" — jetzt persistiert unter
// <userData>/mail/bridge-settings.json und per Chat-Tool
// mail_triage_config aenderbar. Werte werden beim Lesen UND Schreiben
// geklemmt, damit eine von Hand editierte Datei den Prompt nie flutet.

import { app } from "electron";
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface MailBridgeSettings {
  /** Wieviele vorherige Thread-Nachrichten maximal in den Prompt gehen. */
  threadContextLimit: number;
  /** Zeichen-Cap je Verlaufs-Nachricht (aktuelle Mail bleibt ungekuerzt). */
  threadBodyCap: number;
}

const DEFAULTS: MailBridgeSettings = {
  threadContextLimit: 10,
  threadBodyCap: 1_200,
};

function clamp(s: Partial<MailBridgeSettings>): MailBridgeSettings {
  const limitRaw = Number(s.threadContextLimit);
  const capRaw = Number(s.threadBodyCap);
  return {
    threadContextLimit: Number.isFinite(limitRaw)
      ? Math.max(0, Math.min(50, Math.round(limitRaw)))
      : DEFAULTS.threadContextLimit,
    threadBodyCap: Number.isFinite(capRaw)
      ? Math.max(200, Math.min(5_000, Math.round(capRaw)))
      : DEFAULTS.threadBodyCap,
  };
}

function settingsPath(): string {
  return join(app.getPath("userData"), "mail", "bridge-settings.json");
}

let cache: MailBridgeSettings | null = null;

export function getMailBridgeSettings(): MailBridgeSettings {
  if (cache) return { ...cache };
  try {
    if (existsSync(settingsPath())) {
      cache = clamp(
        JSON.parse(readFileSync(settingsPath(), "utf8")) as Partial<MailBridgeSettings>,
      );
      return { ...cache };
    }
  } catch {
    /* korrupt → Defaults */
  }
  cache = { ...DEFAULTS };
  return { ...cache };
}

export function setMailBridgeSettings(
  patch: Partial<MailBridgeSettings>,
): MailBridgeSettings {
  const next = clamp({ ...getMailBridgeSettings(), ...patch });
  try {
    mkdirSync(join(app.getPath("userData"), "mail"), { recursive: true });
    const tmp = `${settingsPath()}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2), "utf8");
    renameSync(tmp, settingsPath());
  } catch (err) {
    console.warn("[mail-bridge-settings] persist failed:", err);
  }
  cache = next;
  return { ...next };
}
