// v0.1.225 — KnowledgeManager: Lifecycle + Routing.
//
// Hält pro Provider-Kind genau einen Adapter, leitet Chat-Tools und
// IPC-Calls an den richtigen Adapter. Sehr dünn — die eigentliche
// Logik lebt im Adapter selbst (siehe notion-adapter.ts).
//
// Im Gegensatz zum CRM-Modul (`crm/index.ts`) brauchen wir hier
// kein OAuth-Flow-Sub-System: PAT-Tokens kommen direkt rein und
// werden in `KnowledgeProviderStore` verschlüsselt abgelegt.

import { EventEmitter } from "node:events";
import type {
  KnowledgeProviderKind,
  KnowledgeProvidersSnapshot,
} from "../../shared/types";
import type {
  KnowledgeAdapter,
  KnowledgeContent,
  KnowledgeItem,
  KnowledgeSchema,
  KnowledgeSearchHit,
  KnowledgeUpdate,
} from "./types";
import { NotionAdapter } from "./notion-adapter";
import { ObsidianAdapter } from "./obsidian-adapter";
import { KnowledgeProviderStore } from "./store";

export interface KnowledgeManagerEvents {
  /** Wird re-emitted vom Store; Renderer subscribt via IPC. */
  statusChanged: (kind: KnowledgeProviderKind) => void;
}

export declare interface KnowledgeManager {
  on<E extends keyof KnowledgeManagerEvents>(
    event: E,
    listener: KnowledgeManagerEvents[E],
  ): this;
  emit<E extends keyof KnowledgeManagerEvents>(
    event: E,
    ...args: Parameters<KnowledgeManagerEvents[E]>
  ): boolean;
}

export class KnowledgeManager extends EventEmitter {
  private static instance: KnowledgeManager | null = null;
  private readonly store = KnowledgeProviderStore.shared();
  private readonly adapters: Map<KnowledgeProviderKind, KnowledgeAdapter> =
    new Map();

  private constructor() {
    super();
    // P2: Notion-Adapter.
    const notion = new NotionAdapter();
    notion.attach();
    this.adapters.set("notion", notion);

    // P3: Obsidian-Adapter (Local-REST-API-Plugin).
    const obsidian = new ObsidianAdapter();
    obsidian.attach();
    this.adapters.set("obsidian", obsidian);

    // Status-Mutationen vom Store nach außen tunneln.
    this.store.on("statusChanged", (kind) => {
      this.emit("statusChanged", kind);
    });
  }

  static shared(): KnowledgeManager {
    if (!this.instance) this.instance = new KnowledgeManager();
    return this.instance;
  }

  snapshot(): KnowledgeProvidersSnapshot {
    return this.store.snapshot();
  }

  /** Wirft, wenn der Provider nicht registriert ist (z. B. Obsidian
   *  vor P3). Caller sollten `snapshot()` zuerst prüfen. */
  getAdapter(kind: KnowledgeProviderKind): KnowledgeAdapter {
    const a = this.adapters.get(kind);
    if (!a) {
      throw new Error(
        `Knowledge-Provider "${kind}" ist in dieser Version noch nicht verbunden ` +
          `(folgt in einer kommenden Version).`,
      );
    }
    return a;
  }

  // ---- Convenience-Pass-Through für IPC + Chat-Tools -----------------------

  async connect(
    kind: KnowledgeProviderKind,
    token: string,
  ): Promise<void> {
    await this.getAdapter(kind).connect({ token });
  }

  async disconnect(kind: KnowledgeProviderKind): Promise<void> {
    await this.getAdapter(kind).disconnect();
  }

  async search(
    kind: KnowledgeProviderKind,
    query: string,
    opts?: { limit?: number },
  ): Promise<KnowledgeSearchHit[]> {
    return this.getAdapter(kind).search(query, opts);
  }

  async getItem(
    kind: KnowledgeProviderKind,
    id: string,
  ): Promise<KnowledgeItem> {
    return this.getAdapter(kind).getItem(id);
  }

  async updateItem(
    kind: KnowledgeProviderKind,
    id: string,
    patch: KnowledgeUpdate,
  ): Promise<KnowledgeItem> {
    return this.getAdapter(kind).updateItem(id, patch);
  }

  async createItem(
    kind: KnowledgeProviderKind,
    parent: string | null,
    content: KnowledgeContent,
  ): Promise<KnowledgeItem> {
    return this.getAdapter(kind).createItem(parent, content);
  }

  // v0.1.293 — Soft-Delete. Bei Notion: archived=true (30-Tage-Trash).
  // Bei Obsidian: wirft (nicht implementiert in P3).
  async deleteItem(
    kind: KnowledgeProviderKind,
    id: string,
  ): Promise<void> {
    return this.getAdapter(kind).deleteItem(id);
  }

  async introspectSchema(
    kind: KnowledgeProviderKind,
    containerId?: string | null,
  ): Promise<KnowledgeSchema> {
    return this.getAdapter(kind).introspectSchema(containerId);
  }

  /** Notion-spezifischer Helper für Chat-Tool. P3 ergänzt eine
   *  äquivalente Obsidian-Funktion (`listVaultFolders`?). */
  async listNotionDatabases(): Promise<
    Array<{ id: string; title: string; url: string }>
  > {
    const adapter = this.getAdapter("notion");
    if (!(adapter instanceof NotionAdapter)) {
      throw new Error("Notion-Adapter nicht initialisiert.");
    }
    return adapter.listDatabases();
  }

  async queryNotionDatabase(
    databaseId: string,
    opts?: { filter?: unknown; sorts?: unknown; pageSize?: number },
  ): Promise<KnowledgeItem[]> {
    const adapter = this.getAdapter("notion");
    if (!(adapter instanceof NotionAdapter)) {
      throw new Error("Notion-Adapter nicht initialisiert.");
    }
    return adapter.queryDatabase(databaseId, opts);
  }

  /** v0.1.235 — Obsidian-Folder-Listing. Nicht im KnowledgeAdapter-
   *  Interface (Notion hat kein Äquivalent — dort gibt es DBs, keine
   *  Ordner-Hierarchie), darum dieser direkte Pfad. */
  async listObsidianFolder(
    folder: string | null,
  ): Promise<Array<{ path: string; isFolder: boolean }>> {
    const adapter = this.getAdapter("obsidian");
    if (!(adapter instanceof ObsidianAdapter)) {
      throw new Error("Obsidian-Adapter nicht initialisiert.");
    }
    return adapter.listFolder(folder);
  }
}
