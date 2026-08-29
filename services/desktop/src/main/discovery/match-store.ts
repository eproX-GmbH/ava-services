// Phase 3 Firmen-Discovery — lokaler Match-Store.
//
// Score + Begruendung sind NUTZERBEZOGEN (das ICP ist privat) und
// bleiben deshalb lokal: userData/discovery/matches.json. Der geteilte
// zentrale Bestand kennt keine Scores.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";

export interface MatchEntry {
  score: number;
  begruendung: string;
  matchedAt: string;
}

export class MatchStore {
  readonly path: string;
  private readonly dir: string;
  private cache: Record<string, MatchEntry> | null = null;

  constructor(dir?: string) {
    this.dir = dir ?? join(app.getPath("userData"), "discovery");
    this.path = join(this.dir, "matches.json");
  }

  getAll(): Record<string, MatchEntry> {
    if (this.cache !== null) return this.cache;
    if (!existsSync(this.path)) {
      this.cache = {};
      return this.cache;
    }
    try {
      this.cache = JSON.parse(readFileSync(this.path, "utf8")) as Record<
        string,
        MatchEntry
      >;
    } catch (err) {
      console.warn("[discovery-match] read failed:", err);
      this.cache = {};
    }
    return this.cache;
  }

  setMany(entries: Record<string, MatchEntry>): void {
    const all = { ...this.getAll(), ...entries };
    // Cap: nur die neuesten 2000 behalten.
    const keys = Object.keys(all);
    if (keys.length > 2000) {
      keys
        .sort((a, b) => (all[a]!.matchedAt < all[b]!.matchedAt ? -1 : 1))
        .slice(0, keys.length - 2000)
        .forEach((k) => delete all[k]);
    }
    this.cache = all;
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(this.path, JSON.stringify(all), "utf8");
    } catch (err) {
      console.warn("[discovery-match] persist failed:", err);
    }
  }
}
