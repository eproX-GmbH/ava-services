// v0.1.424 — Einstellung „Publikations-Analyse" (PB1, Lazy-RAG-Plan).
//
// Steuert, wie tief der company-publication-Producer Jahresabschluesse
// per LLM durchleuchtet:
//
//   "lazy"  (Default) — nur trend-relevante Bloecke (gefiltert + gedeckelt).
//   "eager" (Opt-in)  — jeder Block einzeln, alle Jahre (teuer/langsam).
//
// Kleiner JSON-Store nach dem Muster von research/store.ts: atomares
// Schreiben, EventEmitter fuer den Producer-Neustart bei Aenderung.

import { EventEmitter } from "node:events";
import { app } from "electron";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export type PublicationAnalysisMode = "lazy" | "eager";

export interface PublicationStoreEvents {
  changed: (mode: PublicationAnalysisMode) => void;
}

export declare interface PublicationStore {
  on<K extends keyof PublicationStoreEvents>(
    event: K,
    listener: PublicationStoreEvents[K],
  ): this;
  emit<K extends keyof PublicationStoreEvents>(
    event: K,
    ...args: Parameters<PublicationStoreEvents[K]>
  ): boolean;
}

export class PublicationStore extends EventEmitter {
  private cached: PublicationAnalysisMode;

  constructor() {
    super();
    this.cached = this.readFromDisk();
  }

  private dir(): string {
    return join(app.getPath("userData"), "publication");
  }

  private filePath(): string {
    return join(this.dir(), "analysis.json");
  }

  getMode(): PublicationAnalysisMode {
    return this.cached;
  }

  setMode(mode: PublicationAnalysisMode): PublicationAnalysisMode {
    const next: PublicationAnalysisMode = mode === "eager" ? "eager" : "lazy";
    if (next === this.cached) return next;
    try {
      if (!existsSync(this.dir())) mkdirSync(this.dir(), { recursive: true });
      const tmp = `${this.filePath()}.tmp`;
      writeFileSync(tmp, JSON.stringify({ mode: next }, null, 2), {
        mode: 0o600,
      });
      renameSync(tmp, this.filePath());
    } catch (err) {
      console.warn("[publication] Einstellung schreiben fehlgeschlagen:", err);
    }
    this.cached = next;
    this.emit("changed", next);
    return next;
  }

  private readFromDisk(): PublicationAnalysisMode {
    try {
      const raw = readFileSync(this.filePath(), "utf8");
      const parsed = JSON.parse(raw) as { mode?: unknown };
      return parsed.mode === "eager" ? "eager" : "lazy";
    } catch {
      return "lazy";
    }
  }
}
