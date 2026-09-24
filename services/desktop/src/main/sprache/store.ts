// Sprachmodus — Einstellungen (docs/PLAN_SPRACHMODUS.md, S0).
//
// userData/sprache.json: { aktiv, stimme, ruheSekunden, signalton, wachwort }.
// Schluessel liegen NICHT hier (ProviderConfigStore / Organisation).

import { EventEmitter } from "node:events";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import type { SpracheEinstellungen, SpracheStimme } from "../../shared/types";

export const SPRACHE_STIMMEN: ReadonlyArray<{ id: SpracheStimme; label: string; hinweis: string }> = [
  { id: "marin", label: "Marin", hinweis: "Standard, von OpenAI empfohlen" },
  { id: "coral", label: "Coral", hinweis: "warm" },
  { id: "sage", label: "Sage", hinweis: "ruhig" },
  { id: "shimmer", label: "Shimmer", hinweis: "hell" },
];
const STIMMEN = new Set(SPRACHE_STIMMEN.map((s) => s.id));

const DEFAULT: SpracheEinstellungen = { aktiv: false, stimme: "marin", ruheSekunden: 20, signalton: true, wachwort: true };

export class SpracheStore extends EventEmitter {
  private static instance: SpracheStore | null = null;
  private readonly path: string;
  private cached: SpracheEinstellungen;

  private constructor() {
    super();
    this.path = join(app.getPath("userData"), "sprache.json");
    this.cached = this.lesen();
  }

  static shared(): SpracheStore {
    if (!this.instance) this.instance = new SpracheStore();
    return this.instance;
  }

  get(): SpracheEinstellungen {
    return { ...this.cached };
  }

  setzen(teil: Partial<SpracheEinstellungen>): SpracheEinstellungen {
    const next: SpracheEinstellungen = { ...this.cached };
    if (typeof teil.aktiv === "boolean") next.aktiv = teil.aktiv;
    if (teil.stimme && STIMMEN.has(teil.stimme)) next.stimme = teil.stimme;
    if (typeof teil.ruheSekunden === "number" && Number.isFinite(teil.ruheSekunden)) next.ruheSekunden = Math.min(120, Math.max(5, Math.round(teil.ruheSekunden)));
    if (typeof teil.signalton === "boolean") next.signalton = teil.signalton;
    if (typeof teil.wachwort === "boolean") next.wachwort = teil.wachwort;
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
    this.cached = next;
    this.emit("changed", { ...next });
    return { ...next };
  }

  private lesen(): SpracheEinstellungen {
    if (!existsSync(this.path)) return { ...DEFAULT };
    try {
      const roh = JSON.parse(readFileSync(this.path, "utf8")) as Partial<SpracheEinstellungen>;
      const aus = { ...DEFAULT };
      if (typeof roh.aktiv === "boolean") aus.aktiv = roh.aktiv;
      if (roh.stimme && STIMMEN.has(roh.stimme)) aus.stimme = roh.stimme;
      if (typeof roh.ruheSekunden === "number") aus.ruheSekunden = Math.min(120, Math.max(5, roh.ruheSekunden));
      if (typeof roh.signalton === "boolean") aus.signalton = roh.signalton;
      if (typeof roh.wachwort === "boolean") aus.wachwort = roh.wachwort;
      return aus;
    } catch {
      return { ...DEFAULT };
    }
  }
}
