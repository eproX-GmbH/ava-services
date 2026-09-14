// v0.1.650 (docs/PLAN_CHAT_VORSCHLAEGE.md, V5) — persoenliche Einstellung fuer
// Vorschlaege: Startseite und Gespraech getrennt schaltbar (Standard an).
// Die Organisations-Vorgabe "vorschlaege" (Feature) uebersteuert beides.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface VorschlaegeSettings {
  startseite: boolean;
  gespraech: boolean;
}

const DEFAULT: VorschlaegeSettings = { startseite: true, gespraech: true };

export class VorschlaegeSettingsStore {
  private readonly path: string;
  private cache: VorschlaegeSettings | null = null;

  constructor(dir: string) {
    this.path = join(dir, "settings.json");
  }

  get(): VorschlaegeSettings {
    if (this.cache) return this.cache;
    try {
      const raw = existsSync(this.path) ? (JSON.parse(readFileSync(this.path, "utf8")) as Partial<VorschlaegeSettings>) : {};
      this.cache = { startseite: raw.startseite !== false, gespraech: raw.gespraech !== false };
    } catch {
      this.cache = { ...DEFAULT };
    }
    return this.cache;
  }

  set(patch: Partial<VorschlaegeSettings>): VorschlaegeSettings {
    const next = { ...this.get(), ...patch };
    this.cache = next;
    try {
      mkdirSync(join(this.path, ".."), { recursive: true });
      writeFileSync(this.path, JSON.stringify(next, null, 2), "utf8");
    } catch {
      /* best-effort */
    }
    return next;
  }
}
