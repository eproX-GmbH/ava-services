// I5 ICP-Assistent (docs/PLAN_ICP_ASSISTENT.md) — Top-Kunden-Profile.
//
// Lokale Profile (Kurztext + 768d-Embedding) der besten Bestandskunden
// aus dem ICP (K9). Dienen dem Radar-Match als Aehnlichkeits-Signal
// ("dieser Kandidat aehnelt deinem Bestandskunden X"). Entscheidung B1:
// strikt LOKAL — userData/discovery/customer-profiles.json, nie zentral.
//
// Befuellt von der ICP-URL-Analyse (I2) und lazy vom Matcher fuer
// Domains, die nur manuell (ohne Analyse) eingetragen wurden.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";

export interface CustomerProfile {
  profileText: string;
  embedding: number[] | null;
  updatedAt: string;
}

export class CustomerProfileStore {
  readonly path: string;
  private readonly dir: string;
  private cache: Record<string, CustomerProfile> | null = null;

  constructor(dir?: string) {
    this.dir = dir ?? join(app.getPath("userData"), "discovery");
    this.path = join(this.dir, "customer-profiles.json");
  }

  getAll(): Record<string, CustomerProfile> {
    if (this.cache !== null) return this.cache;
    if (!existsSync(this.path)) {
      this.cache = {};
      return this.cache;
    }
    try {
      this.cache = JSON.parse(readFileSync(this.path, "utf8")) as Record<
        string,
        CustomerProfile
      >;
    } catch (err) {
      console.warn("[customer-profiles] read failed:", err);
      this.cache = {};
    }
    return this.cache;
  }

  get(domain: string): CustomerProfile | null {
    return this.getAll()[domain] ?? null;
  }

  set(domain: string, profile: Omit<CustomerProfile, "updatedAt">): void {
    const all = { ...this.getAll() };
    all[domain] = { ...profile, updatedAt: new Date().toISOString() };
    // Cap: nur die 20 neuesten behalten (ICP erlaubt max 5 Kunden;
    // Historie alter Domains muss nicht wachsen).
    const keys = Object.keys(all);
    if (keys.length > 20) {
      keys
        .sort((a, b) => (all[a]!.updatedAt < all[b]!.updatedAt ? -1 : 1))
        .slice(0, keys.length - 20)
        .forEach((k) => delete all[k]);
    }
    this.cache = all;
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(this.path, JSON.stringify(all), "utf8");
    } catch (err) {
      console.warn("[customer-profiles] persist failed:", err);
    }
  }
}
