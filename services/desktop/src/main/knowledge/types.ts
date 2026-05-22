// v0.1.224 — Adapter-Interface für Knowledge-Integrationen.
//
// Wird in P2 (Notion) + P3 (Obsidian) implementiert. Wir definieren
// das Interface jetzt schon, damit:
//   - die Skelett-Store-Logik (status / connect / disconnect) gegen
//     den Vertrag programmieren kann
//   - Tests einen Mock-Adapter implementieren können
//   - neue Provider später dem Pattern folgen, statt jedes Mal
//     einen eigenen Ad-hoc-Ansatz zu nehmen
//
// Ziele:
//   - Keine Provider-API-Spezifika hier durchschlagen (Notions
//     "block"-Konzept und Obsidians "frontmatter" sind beides
//     `KnowledgeItem`-Subtypen)
//   - Lesen und Schreiben austauschbar
//   - Schema-Introspection als first-class operation, weil
//     CRM-Workflows die dynamische Struktur des Targets brauchen

import type {
  KnowledgeProviderKind,
  KnowledgeProviderStatus,
} from "../../shared/types";

export interface KnowledgeSearchHit {
  /** Adapter-stabile ID; bei Notion = page-id, bei Obsidian = file-
   *  path. */
  id: string;
  /** Anzeigetitel. */
  title: string;
  /** Optional: kurzer Ausschnitt (für Such-Treffer-Liste). */
  snippet?: string;
  /** Optional: Provider-spezifischer Typ-Hinweis (Notion: "page" /
   *  "database"; Obsidian: "note" / "daily" / "canvas"). */
  type?: string;
  /** Direkter URL zum Item, falls Provider eine öffentliche oder
   *  app-interne URL anbietet. */
  url?: string;
}

export interface KnowledgeItem {
  id: string;
  title: string;
  /** Roher Body — markdown-ähnlich. Beim Notion-Adapter konvertieren
   *  wir Blocks zu Markdown, beim Obsidian-Adapter ist es die
   *  Datei selbst. */
  content: string;
  /** Schlüssel-Wert-Properties — bei Notion = Database-Properties,
   *  bei Obsidian = Frontmatter. */
  properties?: Record<string, unknown>;
  /** ISO-8601. */
  createdAt?: string;
  updatedAt?: string;
  url?: string;
  /** v0.1.237 — Nicht-fatale Schema-Mapping-Warnungen aus dem letzten
   *  Adapter-Call, z. B. „Property 'Aktion' nicht im DB-Schema" oder
   *  „Status-Option 'X' existiert nicht". Bei `updateItem` setzt der
   *  Adapter das, wenn einzelne Properties stillschweigend gedropped
   *  wurden — der Agent sieht so, dass nicht ALLES wie gewünscht
   *  reinging, auch wenn der Gesamt-Call durchlief. */
  warnings?: string[];
  /** v0.1.254 — Optional: vollständige Diagnose-Daten aus dem letzten
   *  PATCH-Aufruf. Wird gesetzt, wenn `updateItem` einen `verify-after-
   *  Mismatch` erkennt ODER wenn die Tool-Beschreibung die Diagnose
   *  explizit anfordert. Hilft beim Debuggen „silent no-op"-Fällen,
   *  wo Notion HTTP 200 antwortet aber serverseitig nichts ändert.
   *  v0.1.296 — Shape pro Adapter unterschiedlich (Notion vs. Obsidian
   *  haben verschiedene Field-Sets). Wir tippen als offene Map; jeder
   *  Adapter dokumentiert seine Keys via Kommentar oben am Aufrufer.
   */
  diagnostics?: Record<string, unknown>;
}

export interface KnowledgeContent {
  title?: string;
  content?: string;
  properties?: Record<string, unknown>;
}

export interface KnowledgeUpdate {
  /** Properties patchen (bei Notion = Property-Update, bei Obsidian =
   *  Frontmatter-Patch). */
  properties?: Record<string, unknown>;
  /** Neue Blocks/Zeilen am Ende des Items anhängen. */
  appendContent?: string;
  /** Existierenden Body ganz ersetzen. Vorsicht: ersetzt das ganze
   *  Item. */
  replaceContent?: string;
}

export interface KnowledgeSchemaProperty {
  name: string;
  /** Provider-spezifischer Typ ("title" / "rich_text" / "select" /
   *  "multi_select" / "date" / "number" / "checkbox" / "status" / …).
   *  Wird unverändert vom Provider übernommen, damit der Caller die
   *  exakte Semantik des Targets sieht. */
  type: string;
  /** Bei Select/Multi-Select: die verfügbaren Optionen. */
  options?: string[];
  /** Bei numerischen Properties: Number-Format-Hinweis. */
  format?: string;
}

export interface KnowledgeSchema {
  /** Für Notion: Database-ID. Für Obsidian: null (Vault-global). */
  containerId: string | null;
  containerTitle: string;
  properties: KnowledgeSchemaProperty[];
}

export interface KnowledgeAdapter {
  readonly kind: KnowledgeProviderKind;

  /** Status-Snapshot — billig, kein I/O. */
  getStatus(): KnowledgeProviderStatus;

  /** Token / API-Credentials persistieren + Verbindung initialisieren.
   *  Schema- / DisplayName-Probe wird ausgelöst. */
  connect(credentials: { token: string }): Promise<KnowledgeProviderStatus>;

  /** Credentials wegwerfen + Status zurücksetzen. */
  disconnect(): Promise<void>;

  /** Workspace-/Vault-weite Suche. */
  search(query: string, opts?: { limit?: number }): Promise<KnowledgeSearchHit[]>;

  /** Einzelnes Item laden. */
  getItem(id: string): Promise<KnowledgeItem>;

  /** Item updaten. */
  updateItem(id: string, patch: KnowledgeUpdate): Promise<KnowledgeItem>;

  /** Neues Item anlegen. `parent` ist Provider-spezifisch:
   *    - Notion: Database-ID oder Page-ID
   *    - Obsidian: Ordner-Pfad (null = Vault-Root) */
  createItem(
    parent: string | null,
    content: KnowledgeContent,
  ): Promise<KnowledgeItem>;

  /** Schema-Introspection. Bei Notion: zeigt Database-Properties.
   *  Bei Obsidian: scannt Frontmatter-Felder im Vault. */
  introspectSchema(containerId?: string | null): Promise<KnowledgeSchema>;

  /** v0.1.293 — Item löschen (Provider-spezifisch).
   *    - Notion: PATCH /v1/pages/:id { archived: true } — soft-delete,
   *      30 Tage im Notion-Trash wiederherstellbar.
   *    - Obsidian: nicht implementiert (P3+).
   */
  deleteItem(id: string): Promise<void>;
}
