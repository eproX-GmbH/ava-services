// Node-Umsetzung der Plattform-Schicht: headless Server und Test-Skripte.
//
// Pfade: `AVA_DATA_DIR` ist der Konto-Space (Standard ~/.ava). Ressourcen
// (Producer, Ollama, Whisper, Skills) liegen unter `AVA_RESOURCES_DIR`; ist es
// gesetzt, gilt die AVA als paketiert, sonst als Entwicklungsstand.
//
// Geheimnisse: AES-256-GCM mit einem Schlüssel aus `AVA_SECRETS_KEY` (32 Byte,
// hex oder base64, z. B. ein Docker-Secret). Ohne Schlüssel ist die Ablage
// "nicht verfügbar", und die Stores verhalten sich wie heute ohne Schlüsselbund.
// Lektion aus der OpenClaw-Kritik: nie unverschlüsselt auf die Platte.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { CredentialStore, Platform, PathName } from "./platform";

const MAGIC = Buffer.from("AVA1");

function schluessel(): Buffer | null {
  const raw = process.env.AVA_SECRETS_KEY?.trim();
  if (!raw) return null;
  const hex = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, "hex") : null;
  const b = hex ?? Buffer.from(raw, "base64");
  return b.length === 32 ? b : null;
}

export function createNodeCredentialStore(): CredentialStore {
  const key = schluessel();
  return {
    isEncryptionAvailable: () => key !== null,
    encryptString(plain) {
      if (!key) throw new Error("AVA_SECRETS_KEY fehlt: Geheimnisse können nicht verschlüsselt werden");
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
      return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), enc]);
    },
    decryptString(data) {
      if (!key) throw new Error("AVA_SECRETS_KEY fehlt: Geheimnisse können nicht entschlüsselt werden");
      if (data.length < 4 + 12 + 16 || !data.subarray(0, 4).equals(MAGIC)) throw new Error("Unbekanntes Geheimnis-Format");
      const iv = data.subarray(4, 16);
      const tag = data.subarray(16, 32);
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(data.subarray(32)), decipher.final()]).toString("utf8");
    },
  };
}

export function createNodePlatform(): Platform {
  const dataDir = process.env.AVA_DATA_DIR?.trim() || join(homedir(), ".ava");
  const resourcesDir = process.env.AVA_RESOURCES_DIR?.trim() || null;
  const pfade: Record<PathName, () => string> = {
    userData: () => dataDir,
    logs: () => join(dataDir, "logs"),
    home: () => homedir(),
    downloads: () => join(dataDir, "downloads"),
    exe: () => process.execPath,
    temp: () => tmpdir(),
  };
  const beforeQuit: Array<() => void> = [];
  const beenden = (): void => {
    for (const h of beforeQuit.splice(0)) {
      try {
        h();
      } catch (err) {
        console.warn("[platform] before-quit fehlgeschlagen:", err);
      }
    }
  };
  return {
    kind: "node",
    paths: {
      get: (name) => pfade[name](),
      isPackaged: resourcesDir !== null,
      version: () => process.env.AVA_VERSION?.trim() || "0.0.0-server",
      appPath: () => process.cwd(),
      resources: () => resourcesDir,
      locale: () => process.env.LANG?.split(".")[0]?.replace("_", "-") || "de-DE",
    },
    credentials: createNodeCredentialStore(),
    notifier: {
      isSupported: () => false,
      show: () => false,
    },
    opener: {
      openExternal: async (url) => {
        console.log(`[platform] Link nicht geöffnet (kein Desktop): ${url}`);
      },
      openPath: async () => "Kein Desktop: Dateien werden nicht geöffnet",
      showItemInFolder: () => {},
    },
    spawner: {
      nodeCommand: () => ({ command: process.execPath, env: {} }),
    },
    windows: {
      hasWindows: () => false,
      isAnyFocused: () => false,
      broadcast: () => {},
      focusMain: () => {},
    },
    power: {
      isOnBatteryPower: () => false,
      on: () => {},
    },
    lifecycle: {
      relaunch: () => {
        // Code 75 (EX_TEMPFAIL): Docker (restart unless-stopped) und Fly
        // (restart on-failure) starten den Prozess dann sicher neu.
        console.log("[platform] Neustart angefordert: Prozess endet mit 75, die Hülle startet ihn neu");
        beenden();
        process.exit(75);
      },
      exit: (code) => {
        beenden();
        process.exit(code);
      },
      // Signale (SIGTERM/SIGINT) behandelt der Server-Einstieg selbst und ruft
      // am Ende exit(); so laufen erst die Stopp-Schritte, dann die Handler.
      onBeforeQuit: (handler) => {
        beforeQuit.push(handler);
      },
    },
  };
}
