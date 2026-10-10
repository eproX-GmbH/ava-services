// Instanz dieser AVA (docs/PLAN_AVA_CLOUD.md §13.1): feste ID, Art und Name,
// dazu die Einstellung, ob diese Instanz MCP-Aufrufe beantwortet. Liegt in
// `instanz.json` im Datenverzeichnis und ist instanzgebunden: Ein Umzug (§13.3)
// überschreibt sie nicht.

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { paths, platform } from "../platform";

export type InstanzArt = "desktop" | "server";

export interface InstanzDaten {
  id: string;
  name: string;
  /** Diese Instanz beantwortet MCP-Aufrufe (Standard an). */
  mcp: boolean;
}

export const INSTANZ_DATEI = "instanz.json";

function standardName(art: InstanzArt): string {
  if (art === "server") {
    const app = process.env.AVA_INSTANZ_NAME?.trim() || process.env.FLY_APP_NAME?.trim();
    return app ? `Server ${app}` : "Server";
  }
  const h = hostname().replace(/\.local$/, "");
  return h ? `Desktop ${h}` : "Desktop";
}

export class InstanzStore {
  private daten: InstanzDaten;
  readonly art: InstanzArt;

  constructor() {
    this.art = platform().kind === "electron" ? "desktop" : "server";
    const pfad = this.pfad();
    let d: Partial<InstanzDaten> = {};
    if (existsSync(pfad)) {
      try {
        d = JSON.parse(readFileSync(pfad, "utf8")) as Partial<InstanzDaten>;
      } catch {
        d = {};
      }
    }
    this.daten = {
      id: typeof d.id === "string" && d.id.length >= 8 ? d.id : randomUUID(),
      name: typeof d.name === "string" && d.name.trim() ? d.name.trim() : standardName(this.art),
      mcp: d.mcp !== false,
    };
    this.speichern();
  }

  private pfad(): string {
    return join(paths().get("userData"), INSTANZ_DATEI);
  }

  private speichern(): void {
    try {
      writeFileSync(this.pfad(), JSON.stringify(this.daten, null, 2), "utf8");
    } catch (err) {
      console.warn("[instanz] speichern fehlgeschlagen:", err instanceof Error ? err.message : String(err));
    }
  }

  get(): InstanzDaten & { art: InstanzArt } {
    return { ...this.daten, art: this.art };
  }

  set(patch: { name?: string; mcp?: boolean }): InstanzDaten & { art: InstanzArt } {
    if (typeof patch.name === "string" && patch.name.trim()) this.daten.name = patch.name.trim().slice(0, 80);
    if (typeof patch.mcp === "boolean") this.daten.mcp = patch.mcp;
    this.speichern();
    return this.get();
  }
}
