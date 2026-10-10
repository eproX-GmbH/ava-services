// Feste Anhänge für Mail-Entwürfe (docs/PLAN_MAIL_ENTWURF.md E8): Firmenprofil,
// Referenzen, Preisliste – einmal hinterlegt, bleiben sie (anders als Chat-Uploads,
// die nach 7 Tagen verfallen). Handles beginnen mit fix-. „immer“ heißt: AVA hängt
// die Datei an jeden Outreach-Entwurf. Ohne Electron, läuft auch im Server.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { FEST_PRAEFIX, type FesterAnhang } from "../../shared/mail-entwurf";

export type { FesterAnhang };

export const FEST_MAX_DATEIEN = 10;
export const FEST_MAX_BYTES = 10 * 1024 * 1024;

export class FesteAnhaenge {
  constructor(private readonly ordner: string) {
    mkdirSync(ordner, { recursive: true });
  }

  private index(): string {
    return join(this.ordner, "index.json");
  }

  liste(): FesterAnhang[] {
    try {
      if (!existsSync(this.index())) return [];
      const l = JSON.parse(readFileSync(this.index(), "utf8")) as FesterAnhang[];
      return Array.isArray(l) ? l.filter((a) => existsSync(this.datei(a.id))) : [];
    } catch {
      return [];
    }
  }

  private schreiben(l: FesterAnhang[]): void {
    const tmp = `${this.index()}.tmp`;
    writeFileSync(tmp, JSON.stringify(l, null, 2));
    renameSync(tmp, this.index());
  }

  private datei(id: string): string {
    return join(this.ordner, `${id.replace(/[^a-z0-9-]/gi, "")}.bin`);
  }

  hinzufuegen(input: { name: string; mimeType: string; bytes: Uint8Array; immer?: boolean; beschreibung?: string | null }): FesterAnhang {
    const l = this.liste();
    if (l.length >= FEST_MAX_DATEIEN) throw new Error(`Höchstens ${FEST_MAX_DATEIEN} feste Anhänge. Bitte erst einen entfernen.`);
    if (input.bytes.byteLength > FEST_MAX_BYTES) throw new Error("Die Datei ist größer als 10 MB.");
    const name = basename(input.name).trim().slice(0, 120) || "Anhang";
    // Gleicher Name ersetzt die alte Fassung (neue Preisliste, aktuelles Profil).
    const alt = l.find((a) => a.name.toLowerCase() === name.toLowerCase());
    const id = alt?.id ?? `${FEST_PRAEFIX}${randomUUID().slice(0, 8)}`;
    writeFileSync(this.datei(id), input.bytes);
    const eintrag: FesterAnhang = {
      id,
      name,
      mimeType: input.mimeType || "application/octet-stream",
      sizeBytes: input.bytes.byteLength,
      immer: input.immer ?? alt?.immer ?? false,
      beschreibung: input.beschreibung?.trim().slice(0, 200) || alt?.beschreibung || null,
      angelegt: new Date().toISOString(),
    };
    this.schreiben([...l.filter((a) => a.id !== id), eintrag]);
    return eintrag;
  }

  entfernen(id: string): boolean {
    const l = this.liste();
    if (!l.some((a) => a.id === id)) return false;
    rmSync(this.datei(id), { force: true });
    this.schreiben(l.filter((a) => a.id !== id));
    return true;
  }

  aendern(id: string, teil: { immer?: boolean; beschreibung?: string | null }): FesterAnhang | null {
    const l = this.liste();
    const a = l.find((x) => x.id === id);
    if (!a) return null;
    if (teil.immer !== undefined) a.immer = teil.immer;
    if (teil.beschreibung !== undefined) a.beschreibung = teil.beschreibung?.trim().slice(0, 200) || null;
    this.schreiben(l);
    return a;
  }

  /** Handle (fix-…) oder Dateiname; null, wenn es keinen festen Anhang dazu gibt. */
  aufloesen(angabe: string): { anhang: FesterAnhang; bytes: Buffer } | null {
    const a = angabe.trim().toLowerCase();
    const treffer = this.liste().find((x) => x.id.toLowerCase() === a || x.name.toLowerCase() === a);
    if (!treffer) return null;
    try {
      return { anhang: treffer, bytes: readFileSync(this.datei(treffer.id)) };
    } catch {
      return null;
    }
  }

  /** Für den System-Prompt: kurz, ohne Inhalte. */
  promptText(): string | null {
    const l = this.liste();
    if (l.length === 0) return null;
    return l
      .map((a) => `- ${a.id}: ${a.name}${a.beschreibung ? ` – ${a.beschreibung}` : ""}${a.immer ? " (immer an Outreach-Mails)" : ""}`)
      .join("\n");
  }
}
