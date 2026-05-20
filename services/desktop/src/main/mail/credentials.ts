// v0.1.257 — IMAP/SMTP-Credentials im OS-Keychain.
//
// Passwörter und App-Passwords werden NIE in PGlite gespeichert.
// Stattdessen liegt eine separate Datei `mail-creds.bin` im userData,
// verschlüsselt via Electron's safeStorage (macOS Keychain, Windows
// DPAPI, Linux libsecret).
//
// Auf Plattformen ohne Keychain (manche Linux-Setups) lehnen wir ab —
// Klartext-Speicherung würde Mail-Account-Credentials viel exponierter
// machen als Bookmarks oder ähnliches; ohne Keychain muss der User
// die Creds jeden Start neu eingeben oder das Konto deaktiviert lassen.

import { app, safeStorage } from "electron";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { MailCredentialsPayload } from "../../shared/types";

export class MailCredentialsManager {
  private cached: MailCredentialsPayload | null = null;

  private filePath(): string {
    return join(app.getPath("userData"), "mail-creds.bin");
  }

  isEncryptionAvailable(): boolean {
    return safeStorage.isEncryptionAvailable();
  }

  /** Beide Passwörter setzen. Wirft, wenn safeStorage nicht verfügbar. */
  async save(creds: MailCredentialsPayload): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error(
        "OS-Keychain nicht verfügbar — Mail-Credentials können nicht sicher gespeichert werden.",
      );
    }
    const json = JSON.stringify(creds);
    const enc = safeStorage.encryptString(json);
    await fs.writeFile(this.filePath(), enc, { mode: 0o600 });
    this.cached = creds;
  }

  /** Liefert null, wenn keine Creds hinterlegt sind oder Keychain fehlt. */
  async load(): Promise<MailCredentialsPayload | null> {
    if (this.cached) return this.cached;
    try {
      const buf = await fs.readFile(this.filePath());
      if (!safeStorage.isEncryptionAvailable()) return null;
      const json = safeStorage.decryptString(buf);
      const parsed = JSON.parse(json) as MailCredentialsPayload;
      this.cached = parsed;
      return parsed;
    } catch {
      return null;
    }
  }

  async clear(): Promise<void> {
    this.cached = null;
    await fs.unlink(this.filePath()).catch(() => undefined);
  }
}

