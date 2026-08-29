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

export interface IcpKundenBeispiel {
  /** Normierte Kern-Domain des Bestandskunden. */
  domain: string;
  name?: string;
  ort?: string;
}

export interface IcpProfile {
  /** Freitext: "Welche Firmen sind die perfekten Kunden?" (K-Synthese) */
  beschreibung: string;
  /** K1 — eigenes Angebot (Produkte/Leistungen). */
  angebot: string;
  /** K2 — geloestes Problem / Nutzenversprechen. */
  nutzen: string;
  /** K4 — Zielbranchen. */
  branchen: string[];
  /** K3/K6 — Heimat-Orte fuer den Radar (z. B. ["Hannover"]). */
  orte: string[];
  radiusKm: number;
  /** K5 — Groessen-Praeferenz als Freitext ("10-200 Mitarbeiter", "KMU"). */
  groesse: string;
  /** K7 — weitere Merkmale eines perfekten Kunden. */
  merkmale: string[];
  /** K8 — harte Ausschluesse ("keine Agenturen", "kein Einzelhandel"). */
  ausschluesse: string;
  /** K9 — beste Bestandskunden (bleiben LOKAL — Entscheidung B1). */
  kundenBeispiele: IcpKundenBeispiel[];
  /** Wie das ICP entstand — fuers UI ("per Assistent erstellt"). */
  quelle: "assistent" | "manuell" | "chat" | null;
  updatedAt: string | null;
}

const DEFAULT_ICP: IcpProfile = {
  beschreibung: "",
  angebot: "",
  nutzen: "",
  branchen: [],
  orte: [],
  radiusKm: 50,
  groesse: "",
  merkmale: [],
  ausschluesse: "",
  kundenBeispiele: [],
  quelle: null,
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

function clampStr(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

function normalise(p: Partial<IcpProfile>): IcpProfile {
  const kunden = Array.isArray(p.kundenBeispiele)
    ? p.kundenBeispiele
        .filter(
          (k): k is IcpKundenBeispiel =>
            !!k && typeof k === "object" && typeof k.domain === "string" && k.domain.length >= 4,
        )
        .map((k) => ({
          domain: k.domain.trim().toLowerCase().slice(0, 100),
          ...(k.name ? { name: clampStr(k.name, 200) } : {}),
          ...(k.ort ? { ort: clampStr(k.ort, 80) } : {}),
        }))
        .slice(0, 5)
    : [];
  return {
    beschreibung: clampStr(p.beschreibung, 2000),
    angebot: clampStr(p.angebot, 600),
    nutzen: clampStr(p.nutzen, 600),
    branchen: clampList(p.branchen, 12, 60),
    orte: clampList(p.orte, 5, 80),
    radiusKm:
      typeof p.radiusKm === "number" && Number.isFinite(p.radiusKm)
        ? Math.min(200, Math.max(1, Math.round(p.radiusKm)))
        : 50,
    groesse: clampStr(p.groesse, 200),
    merkmale: clampList(p.merkmale, 10, 120),
    ausschluesse: clampStr(p.ausschluesse, 500),
    kundenBeispiele: kunden,
    quelle:
      p.quelle === "assistent" || p.quelle === "manuell" || p.quelle === "chat"
        ? p.quelle
        : null,
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
      angebot: patch.angebot ?? current.angebot,
      nutzen: patch.nutzen ?? current.nutzen,
      branchen: patch.branchen ?? current.branchen,
      orte: patch.orte ?? current.orte,
      radiusKm: patch.radiusKm ?? current.radiusKm,
      groesse: patch.groesse ?? current.groesse,
      merkmale: patch.merkmale ?? current.merkmale,
      ausschluesse: patch.ausschluesse ?? current.ausschluesse,
      kundenBeispiele: patch.kundenBeispiele ?? current.kundenBeispiele,
      quelle: patch.quelle ?? current.quelle,
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
    if (p.angebot) lines.push(`Eigenes Angebot: ${p.angebot}.`);
    if (p.nutzen) lines.push(`Nutzenversprechen: ${p.nutzen}.`);
    if (p.branchen.length > 0) lines.push(`Branchen: ${p.branchen.join(", ")}.`);
    if (p.groesse) lines.push(`Groesse: ${p.groesse}.`);
    if (p.merkmale.length > 0) lines.push(`Merkmale: ${p.merkmale.join("; ")}.`);
    if (p.orte.length > 0) {
      lines.push(`Region: ${p.orte.join(", ")} (Umkreis ${p.radiusKm} km).`);
    }
    if (p.ausschluesse) lines.push(`Ausschluesse: ${p.ausschluesse}.`);
    return lines.join("\n");
  }
}
