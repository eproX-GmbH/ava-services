// Phase 3 Firmen-Discovery (docs/PLAN_FIRMEN_DISCOVERY.md) — ICP-Store.
//
// Das Idealkundenprofil (ICP) ist die Match-Grundlage des Radars:
// Freitext + strukturierte Felder, gespeichert als
// userData/agent/icp.json (Muster profile-store.ts). Das ICP ist
// PRIVAT — es verlaesst die Nutzer-Maschine nie; der Match laeuft
// lokal (Embedding-Vergleich + LLM-Urteil), nur Entscheidungen gehen
// ans Gateway.
//
// Befuellt wird es typischerweise ueber das icp_set-Tool — z. B. wenn
// der Nutzer die ICP-Frage aus der Welcome-Message beantwortet.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";

export interface IcpProfile {
  /** Freitext: "Welche Firmen sind die perfekten Kunden?" */
  beschreibung: string;
  branchen: string[];
  /** Heimat-Orte fuer den Radar (z. B. ["Hannover"]). */
  orte: string[];
  radiusKm: number;
  /** Groessen-Praeferenz als Freitext ("10-200 Mitarbeiter", "KMU"). */
  groesse: string;
  /** Harte Ausschluesse ("keine Agenturen", "kein Einzelhandel"). */
  ausschluesse: string;
  updatedAt: string | null;
}

const DEFAULT_ICP: IcpProfile = {
  beschreibung: "",
  branchen: [],
  orte: [],
  radiusKm: 50,
  groesse: "",
  ausschluesse: "",
  updatedAt: null,
};

function clampList(v: unknown, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((s): s is string => typeof s === "string")
    .map((s) => s.trim().slice(0, maxLen))
    .filter((s) => s.length > 0)
    .slice(0, maxItems);
}

function normalise(p: Partial<IcpProfile>): IcpProfile {
  return {
    beschreibung:
      typeof p.beschreibung === "string"
        ? p.beschreibung.trim().slice(0, 2000)
        : "",
    branchen: clampList(p.branchen, 12, 60),
    orte: clampList(p.orte, 5, 80),
    radiusKm:
      typeof p.radiusKm === "number" && Number.isFinite(p.radiusKm)
        ? Math.min(200, Math.max(1, Math.round(p.radiusKm)))
        : 50,
    groesse: typeof p.groesse === "string" ? p.groesse.trim().slice(0, 200) : "",
    ausschluesse:
      typeof p.ausschluesse === "string"
        ? p.ausschluesse.trim().slice(0, 500)
        : "",
    updatedAt: typeof p.updatedAt === "string" ? p.updatedAt : null,
  };
}

export class IcpStore {
  readonly path: string;
  private readonly dir: string;
  private cache: IcpProfile | null = null;

  constructor(dir?: string) {
    this.dir = dir ?? join(app.getPath("userData"), "agent");
    this.path = join(this.dir, "icp.json");
  }

  get(): IcpProfile {
    if (this.cache !== null) return this.cache;
    if (!existsSync(this.path)) {
      this.cache = { ...DEFAULT_ICP };
      return this.cache;
    }
    try {
      this.cache = normalise(JSON.parse(readFileSync(this.path, "utf8")));
    } catch (err) {
      console.warn("[icp] read failed; defaults:", err);
      this.cache = { ...DEFAULT_ICP };
    }
    return this.cache;
  }

  /** true, wenn ueberhaupt ein nutzbares ICP vorliegt. */
  isSet(): boolean {
    const p = this.get();
    return p.beschreibung.length >= 10 || p.branchen.length > 0;
  }

  set(patch: Partial<IcpProfile>): IcpProfile {
    const current = this.get();
    const merged = normalise({
      beschreibung: patch.beschreibung ?? current.beschreibung,
      branchen: patch.branchen ?? current.branchen,
      orte: patch.orte ?? current.orte,
      radiusKm: patch.radiusKm ?? current.radiusKm,
      groesse: patch.groesse ?? current.groesse,
      ausschluesse: patch.ausschluesse ?? current.ausschluesse,
      updatedAt: new Date().toISOString(),
    });
    this.cache = merged;
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(this.path, JSON.stringify(merged, null, 2), "utf8");
    } catch (err) {
      console.warn("[icp] persist failed:", err);
    }
    return merged;
  }

  /** ICP als Text fuer Embedding + LLM-Urteil rendern. */
  renderText(): string {
    const p = this.get();
    const lines: string[] = [];
    if (p.beschreibung) lines.push(p.beschreibung);
    if (p.branchen.length > 0) lines.push(`Branchen: ${p.branchen.join(", ")}.`);
    if (p.groesse) lines.push(`Groesse: ${p.groesse}.`);
    if (p.orte.length > 0) {
      lines.push(`Region: ${p.orte.join(", ")} (Umkreis ${p.radiusKm} km).`);
    }
    if (p.ausschluesse) lines.push(`Ausschluesse: ${p.ausschluesse}.`);
    return lines.join("\n");
  }
}
