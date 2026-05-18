// v0.1.225 — Notion-Adapter (Phase 2 von PLANS_knowledge_integrations.md).
//
// Implementiert `KnowledgeAdapter` über die Notion-REST-API. Wir
// nutzen kein offizielles SDK (`@notionhq/client`), weil die API klein
// genug ist, dass uns ein hand-rolled fetch-Wrapper Bundle-Größe und
// Supply-Chain-Risiko spart.
//
// Auth: Bearer-Token (Personal Access Token aus Notion → Settings →
// Integrations). Token wird über `KnowledgeProviderStore` verschlüsselt
// in safeStorage abgelegt.
//
// Scope:
//   - search() → /v1/search (page-und-database-mixed Treffer)
//   - getItem(pageId) → /v1/pages/:id + /v1/blocks/:id/children
//   - updateItem(pageId, patch) → PATCH /v1/pages/:id + PATCH
//     /v1/blocks/:id/children
//   - createItem(parent, content) → POST /v1/pages
//   - introspectSchema(databaseId) → GET /v1/databases/:id
//
// Was bewusst NICHT in P2:
//   - replaceContent (vorhandene Blocks löschen): braucht Block-Walk +
//     Delete-Schleife. Append reicht für CRM-Workflows.
//   - Bilder/Embeds/Code-Blocks rendern: getItem() macht ein
//     minimales Markdown (paragraph, heading_1/2/3, lists, to_do).
//     Rest als Placeholder-Text.
//   - Pagination über mehr als 100 Treffer (default `page_size`).

import type {
  KnowledgeProviderStatus,
} from "../../shared/types";
import type {
  KnowledgeAdapter,
  KnowledgeContent,
  KnowledgeItem,
  KnowledgeSchema,
  KnowledgeSchemaProperty,
  KnowledgeSearchHit,
  KnowledgeUpdate,
} from "./types";
import { KnowledgeProviderStore } from "./store";

const NOTION_API_BASE = "https://api.notion.com";
const NOTION_VERSION = "2022-06-28";

// Undici-fetch wenn verfügbar (Konsistenz mit anderen Stellen im
// Codebase wo Chromium-net-Edge-Cases relevant sind).
let nfetch: typeof fetch = fetch;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  const undici = require("undici") as { fetch?: typeof fetch };
  if (typeof undici.fetch === "function") nfetch = undici.fetch;
} catch {
  /* keep global */
}

export class NotionAdapter implements KnowledgeAdapter {
  readonly kind = "notion" as const;
  private readonly store = KnowledgeProviderStore.shared();
  /** In-Memory-Cache des entschlüsselten Tokens. Bewusst KEIN
   *  Konstruktor-Parameter — wir lesen ihn lazy + invalidieren bei
   *  Token-Change-Event (siehe `attach()`). */
  private cachedToken: string | null = null;

  /**
   * Subscribt sich auf Token-Change-Events. main/index.ts ruft das
   * einmal auf, nachdem der Adapter konstruiert wurde.
   */
  attach(): void {
    this.store.on("tokenChanged", (kind) => {
      if (kind === "notion") this.cachedToken = null;
    });
  }

  getStatus(): KnowledgeProviderStatus {
    return this.store.statusFor("notion");
  }

  async connect(credentials: { token: string }): Promise<KnowledgeProviderStatus> {
    const trimmed = credentials.token.trim();
    if (trimmed.length === 0) {
      throw new Error("Notion-Token ist leer.");
    }
    // Token persistieren — wirft, wenn der OS-Keychain nicht
    // verfügbar ist (Linux ohne libsecret). Knowledge-Tokens nehmen
    // wir absichtlich nur verschlüsselt entgegen.
    this.store.setToken("notion", trimmed);
    this.cachedToken = trimmed;

    // Validierung + Workspace-Display-Name holen. Notion hat keinen
    // dedizierten "whoami"-Endpoint, aber `/v1/users/me` funktioniert
    // mit Integration-Tokens und gibt einen Bot-User mit
    // `owner.workspace=true` zurück.
    try {
      const me = await this.request<NotionUserMeResponse>("/v1/users/me");
      // Bei Integration-Tokens ist `me.bot?.owner` ein
      // `{ type: "workspace" | "user" }`. Display-Name kommt aus
      // `name` (selbst gesetzter Integration-Name).
      const display = me.name ?? "Notion-Workspace";
      return this.store.updateStatus("notion", {
        connected: true,
        displayName: display,
        errorMessage: null,
        lastSyncAt: new Date().toISOString(),
      });
    } catch (err) {
      // Token war ungültig oder Netzwerkfehler. Token IS persistiert,
      // aber wir markieren als errored damit der UI die Verbindungs-
      // Fehlermeldung zeigt. User kann via disconnect() den Token
      // wieder wegmachen.
      const message = humanizeNotionError(err);
      this.store.updateStatus("notion", {
        connected: false,
        errorMessage: message,
      });
      throw new Error(message);
    }
  }

  async disconnect(): Promise<void> {
    this.cachedToken = null;
    this.store.clearToken("notion");
  }

  async search(
    query: string,
    opts?: { limit?: number },
  ): Promise<KnowledgeSearchHit[]> {
    const res = await this.request<NotionSearchResponse>(
      "/v1/search",
      "POST",
      {
        query,
        page_size: Math.min(opts?.limit ?? 25, 100),
      },
    );
    return (res.results ?? []).map((r) => searchResultToHit(r));
  }

  async getItem(id: string): Promise<KnowledgeItem> {
    const page = await this.request<NotionPage>(
      `/v1/pages/${encodeURIComponent(id)}`,
    );
    const blocks = await this.request<NotionBlocksResponse>(
      `/v1/blocks/${encodeURIComponent(id)}/children?page_size=100`,
    );
    return {
      id: page.id,
      title: extractTitle(page),
      content: blocksToMarkdown(blocks.results ?? []),
      properties: simplifyProperties(page.properties),
      createdAt: page.created_time,
      updatedAt: page.last_edited_time,
      url: page.url,
    };
  }

  async updateItem(
    id: string,
    patch: KnowledgeUpdate,
  ): Promise<KnowledgeItem> {
    if (patch.replaceContent !== undefined) {
      throw new Error(
        "Notion-Adapter unterstützt in P2 kein `replaceContent` — bitte " +
          "stattdessen `appendContent` nutzen oder die Seite manuell leeren.",
      );
    }
    if (patch.properties && Object.keys(patch.properties).length > 0) {
      const propsForApi = await this.convertPropertiesForPatch(id, patch.properties);
      await this.request(`/v1/pages/${encodeURIComponent(id)}`, "PATCH", {
        properties: propsForApi,
      });
    }
    if (patch.appendContent && patch.appendContent.trim().length > 0) {
      const children = markdownToBlocks(patch.appendContent);
      await this.request(
        `/v1/blocks/${encodeURIComponent(id)}/children`,
        "PATCH",
        { children },
      );
    }
    return this.getItem(id);
  }

  async createItem(
    parent: string | null,
    content: KnowledgeContent,
  ): Promise<KnowledgeItem> {
    if (!parent) {
      throw new Error(
        "Notion-Adapter braucht einen Parent (Database-ID oder Page-ID). " +
          "Nutze `notion_list_databases` um eine zu finden.",
      );
    }
    // Heuristik: ist der Parent eine Database? Wir checken kurz via
    // /v1/databases/:id. Falls 404 → ist eine Page, wir hängen unter
    // der Page an.
    let parentSpec: NotionParent;
    let propsForApi: Record<string, unknown> = {};
    try {
      const db = await this.request<NotionDatabase>(
        `/v1/databases/${encodeURIComponent(parent)}`,
      );
      parentSpec = { database_id: parent };
      // Properties müssen ans Database-Schema angepasst werden.
      propsForApi = propertiesToApi(
        content.properties ?? {},
        db.properties,
        content.title,
      );
    } catch {
      parentSpec = { page_id: parent };
      // Eine Page (im Gegensatz zur DB-Zeile) hat als einzige
      // Property einen Title.
      if (content.title) {
        propsForApi = {
          title: {
            title: [{ type: "text", text: { content: content.title } }],
          },
        };
      }
    }

    const body: Record<string, unknown> = {
      parent: parentSpec,
      properties: propsForApi,
    };
    if (content.content && content.content.trim().length > 0) {
      body.children = markdownToBlocks(content.content);
    }
    const created = await this.request<NotionPage>(
      "/v1/pages",
      "POST",
      body,
    );
    return this.getItem(created.id);
  }

  async introspectSchema(containerId?: string | null): Promise<KnowledgeSchema> {
    if (!containerId) {
      throw new Error(
        "Notion-Schema-Introspection braucht eine Database-ID. " +
          "Nutze `notion_list_databases` zuerst.",
      );
    }
    const db = await this.request<NotionDatabase>(
      `/v1/databases/${encodeURIComponent(containerId)}`,
    );
    const props: KnowledgeSchemaProperty[] = Object.values(db.properties).map(
      (p) => ({
        name: p.name,
        type: p.type,
        options:
          p.type === "select" && p.select?.options
            ? p.select.options.map((o) => o.name)
            : p.type === "multi_select" && p.multi_select?.options
              ? p.multi_select.options.map((o) => o.name)
              : p.type === "status" && p.status?.options
                ? p.status.options.map((o) => o.name)
                : undefined,
        format:
          p.type === "number" && p.number?.format ? p.number.format : undefined,
      }),
    );
    return {
      containerId: db.id,
      containerTitle: extractDatabaseTitle(db),
      properties: props,
    };
  }

  async listDatabases(): Promise<
    Array<{ id: string; title: string; url: string }>
  > {
    const res = await this.request<NotionSearchResponse>(
      "/v1/search",
      "POST",
      {
        filter: { value: "database", property: "object" },
        page_size: 100,
      },
    );
    return (res.results ?? [])
      .filter((r): r is NotionDatabase => r.object === "database")
      .map((db) => ({
        id: db.id,
        title: extractDatabaseTitle(db),
        url: db.url ?? "",
      }));
  }

  async queryDatabase(
    databaseId: string,
    opts?: { filter?: unknown; sorts?: unknown; pageSize?: number },
  ): Promise<KnowledgeItem[]> {
    const body: Record<string, unknown> = {
      page_size: Math.min(opts?.pageSize ?? 25, 100),
    };
    if (opts?.filter) body.filter = opts.filter;
    if (opts?.sorts) body.sorts = opts.sorts;
    const res = await this.request<NotionSearchResponse>(
      `/v1/databases/${encodeURIComponent(databaseId)}/query`,
      "POST",
      body,
    );
    return (res.results ?? [])
      .filter((r): r is NotionPage => r.object === "page")
      .map((page) => ({
        id: page.id,
        title: extractTitle(page),
        content: "",
        properties: simplifyProperties(page.properties),
        createdAt: page.created_time,
        updatedAt: page.last_edited_time,
        url: page.url,
      }));
  }

  // ---- internals -----------------------------------------------------------

  private async ensureToken(): Promise<string> {
    if (this.cachedToken) return this.cachedToken;
    const t = await this.store.getToken("notion");
    if (!t) {
      throw new Error(
        "Notion ist nicht verbunden. Bitte zuerst über den `notion_connect`-" +
          "Pfad oder Einstellungen → Wissensquellen verbinden.",
      );
    }
    this.cachedToken = t;
    return t;
  }

  private async convertPropertiesForPatch(
    pageId: string,
    properties: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    // Bei Patches müssen wir das DB-Schema des Parents kennen.
    const page = await this.request<NotionPage>(
      `/v1/pages/${encodeURIComponent(pageId)}`,
    );
    if (page.parent.type !== "database_id" || !page.parent.database_id) {
      // Page-im-Page-Hierarchie: nur Title-Patch wird unterstützt.
      const title = properties["title"];
      if (typeof title === "string") {
        return {
          title: {
            title: [{ type: "text", text: { content: title } }],
          },
        };
      }
      return {};
    }
    const db = await this.request<NotionDatabase>(
      `/v1/databases/${encodeURIComponent(page.parent.database_id)}`,
    );
    return propertiesToApi(properties, db.properties);
  }

  private async request<T>(
    path: string,
    method: "GET" | "POST" | "PATCH" | "DELETE" = "GET",
    body?: unknown,
  ): Promise<T> {
    const token = await this.ensureToken();
    const url = NOTION_API_BASE + path;
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      "notion-version": NOTION_VERSION,
    };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const res = await nfetch(url, init);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new NotionApiError(res.status, text);
    }
    return (await res.json()) as T;
  }
}

// ---- API-Types (minimal, nur was wir benutzen) ------------------------------

interface NotionParent {
  database_id?: string;
  page_id?: string;
  type?: "database_id" | "page_id" | "workspace";
}

interface NotionPage {
  object: "page";
  id: string;
  url?: string;
  created_time: string;
  last_edited_time: string;
  parent: NotionParent & { type: "database_id" | "page_id" | "workspace" };
  properties: Record<string, NotionPropertyValue>;
}

interface NotionDatabase {
  object: "database";
  id: string;
  url?: string;
  title?: NotionRichText[];
  properties: Record<string, NotionPropertyDef>;
}

interface NotionPropertyDef {
  id: string;
  name: string;
  type: string;
  select?: { options: Array<{ id: string; name: string; color?: string }> };
  multi_select?: { options: Array<{ id: string; name: string; color?: string }> };
  status?: { options: Array<{ id: string; name: string; color?: string }> };
  number?: { format?: string };
}

interface NotionPropertyValue {
  id?: string;
  type: string;
  title?: NotionRichText[];
  rich_text?: NotionRichText[];
  number?: number | null;
  select?: { name: string } | null;
  multi_select?: Array<{ name: string }>;
  date?: { start: string; end?: string | null } | null;
  checkbox?: boolean;
  url?: string | null;
  email?: string | null;
  phone_number?: string | null;
  status?: { name: string } | null;
  people?: Array<{ id: string; name?: string }>;
}

interface NotionRichText {
  type?: string;
  plain_text?: string;
  text?: { content: string; link?: { url: string } | null };
}

interface NotionBlock {
  object: "block";
  id: string;
  type: string;
  has_children?: boolean;
  paragraph?: { rich_text: NotionRichText[] };
  heading_1?: { rich_text: NotionRichText[] };
  heading_2?: { rich_text: NotionRichText[] };
  heading_3?: { rich_text: NotionRichText[] };
  bulleted_list_item?: { rich_text: NotionRichText[] };
  numbered_list_item?: { rich_text: NotionRichText[] };
  to_do?: { rich_text: NotionRichText[]; checked: boolean };
  code?: { rich_text: NotionRichText[]; language?: string };
  quote?: { rich_text: NotionRichText[] };
  divider?: Record<string, never>;
}

interface NotionBlocksResponse {
  results?: NotionBlock[];
  next_cursor?: string | null;
}

interface NotionSearchResponse {
  results?: Array<NotionPage | NotionDatabase>;
  next_cursor?: string | null;
}

interface NotionUserMeResponse {
  id: string;
  name?: string;
  type?: string;
  bot?: { owner?: { type: string } };
}

class NotionApiError extends Error {
  constructor(public status: number, public body: string) {
    super(`Notion API ${status}: ${body.slice(0, 200)}`);
  }
}

function humanizeNotionError(err: unknown): string {
  if (err instanceof NotionApiError) {
    if (err.status === 401) {
      return "Notion lehnt den Token ab (HTTP 401). Bitte den Token in Notion → Integrations prüfen oder neu erstellen.";
    }
    if (err.status === 403) {
      return "Token ist gültig, aber AVA hat keinen Zugriff. In Notion: Workspace/Page → Connections → AVA hinzufügen.";
    }
    if (err.status === 404) {
      return "Die angefragte Ressource wurde nicht gefunden. Eventuell wurde sie gelöscht oder AVA hat keinen Zugriff darauf.";
    }
    if (err.status === 429) {
      return "Notion drosselt aktuell (Rate-Limit). Bitte in einer Minute erneut versuchen.";
    }
    return `Notion-Fehler: ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}

// ---- Helper für Property-/Block-Konvertierung -------------------------------

function extractTitle(page: NotionPage): string {
  for (const v of Object.values(page.properties)) {
    if (v.type === "title" && v.title && v.title.length > 0) {
      return v.title.map((t) => t.plain_text ?? "").join("");
    }
  }
  return "(ohne Titel)";
}

function extractDatabaseTitle(db: NotionDatabase): string {
  if (!db.title || db.title.length === 0) return "(ohne Titel)";
  return db.title.map((t) => t.plain_text ?? "").join("");
}

function simplifyProperties(
  props: Record<string, NotionPropertyValue>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, p] of Object.entries(props)) {
    out[name] = simplifyPropertyValue(p);
  }
  return out;
}

function simplifyPropertyValue(p: NotionPropertyValue): unknown {
  switch (p.type) {
    case "title":
    case "rich_text":
      return (p[p.type as "title" | "rich_text"] ?? [])
        .map((t) => t.plain_text ?? "")
        .join("");
    case "number":
      return p.number ?? null;
    case "select":
      return p.select?.name ?? null;
    case "multi_select":
      return (p.multi_select ?? []).map((o) => o.name);
    case "date":
      return p.date
        ? p.date.end
          ? { start: p.date.start, end: p.date.end }
          : p.date.start
        : null;
    case "checkbox":
      return !!p.checkbox;
    case "url":
      return p.url ?? null;
    case "email":
      return p.email ?? null;
    case "phone_number":
      return p.phone_number ?? null;
    case "status":
      return p.status?.name ?? null;
    case "people":
      return (p.people ?? []).map((person) => person.name ?? person.id);
    default:
      return null;
  }
}

function propertiesToApi(
  properties: Record<string, unknown>,
  schema: Record<string, NotionPropertyDef>,
  fallbackTitle?: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // Find the title property of the DB — wenn der Caller einen
  // `content.title` mitgegeben hat aber `properties` keinen Eintrag
  // für die Title-Spalte hat, mappen wir den fallback dort hin.
  const titleProp = Object.values(schema).find((p) => p.type === "title");
  for (const [name, value] of Object.entries(properties)) {
    const def = schema[name];
    if (!def) continue; // unbekannte Property → ignorieren
    out[name] = valueToApi(value, def);
  }
  if (
    fallbackTitle &&
    titleProp &&
    !(titleProp.name in out)
  ) {
    out[titleProp.name] = {
      title: [{ type: "text", text: { content: fallbackTitle } }],
    };
  }
  return out;
}

function valueToApi(value: unknown, def: NotionPropertyDef): unknown {
  // v0.1.226 — LLMs schicken Property-Werte in zwei Formen:
  //   (a) flach: "Disqualifiziert" / 42 / true / "2026-07-16"
  //   (b) Notion-Raw: { status: { name: "Disqualifiziert" } } / { number: 42 }
  //
  // (b) hat das Modell vermutlich aus der Notion-API-Doku gelernt und
  // bei einigen Modell-Familien ist es die Default-Wahl. Wir
  // akzeptieren beides — wenn der Wert schon ein Objekt mit dem
  // Typ-Schlüssel ist, reichen wir ihn unverändert weiter.
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    def.type in (value as Record<string, unknown>)
  ) {
    return value;
  }

  switch (def.type) {
    case "title":
      return {
        title: [
          {
            type: "text",
            text: { content: typeof value === "string" ? value : String(value) },
          },
        ],
      };
    case "rich_text":
      return {
        rich_text: [
          {
            type: "text",
            text: { content: typeof value === "string" ? value : String(value) },
          },
        ],
      };
    case "number":
      return { number: typeof value === "number" ? value : Number(value) };
    case "select":
      return { select: { name: String(value) } };
    case "multi_select":
      return {
        multi_select: (Array.isArray(value) ? value : [value]).map((v) => ({
          name: String(v),
        })),
      };
    case "date":
      if (value === null || value === undefined) return { date: null };
      if (typeof value === "string") return { date: { start: value } };
      if (
        value &&
        typeof value === "object" &&
        "start" in value &&
        typeof (value as { start: unknown }).start === "string"
      ) {
        return { date: value };
      }
      return { date: null };
    case "checkbox":
      return { checkbox: !!value };
    case "url":
      return { url: typeof value === "string" ? value : null };
    case "email":
      return { email: typeof value === "string" ? value : null };
    case "phone_number":
      return { phone_number: typeof value === "string" ? value : null };
    case "status":
      return { status: { name: String(value) } };
    default:
      return null;
  }
}

function blocksToMarkdown(blocks: NotionBlock[]): string {
  const lines: string[] = [];
  for (const b of blocks) {
    switch (b.type) {
      case "paragraph":
        lines.push(richTextToString(b.paragraph?.rich_text));
        lines.push("");
        break;
      case "heading_1":
        lines.push(`# ${richTextToString(b.heading_1?.rich_text)}`);
        lines.push("");
        break;
      case "heading_2":
        lines.push(`## ${richTextToString(b.heading_2?.rich_text)}`);
        lines.push("");
        break;
      case "heading_3":
        lines.push(`### ${richTextToString(b.heading_3?.rich_text)}`);
        lines.push("");
        break;
      case "bulleted_list_item":
        lines.push(`- ${richTextToString(b.bulleted_list_item?.rich_text)}`);
        break;
      case "numbered_list_item":
        lines.push(`1. ${richTextToString(b.numbered_list_item?.rich_text)}`);
        break;
      case "to_do": {
        const checked = b.to_do?.checked ? "[x]" : "[ ]";
        lines.push(`- ${checked} ${richTextToString(b.to_do?.rich_text)}`);
        break;
      }
      case "quote":
        lines.push(`> ${richTextToString(b.quote?.rich_text)}`);
        lines.push("");
        break;
      case "code": {
        const lang = b.code?.language ?? "";
        lines.push("```" + lang);
        lines.push(richTextToString(b.code?.rich_text));
        lines.push("```");
        lines.push("");
        break;
      }
      case "divider":
        lines.push("---");
        lines.push("");
        break;
      default:
        lines.push(`[${b.type}-Block]`);
        lines.push("");
    }
  }
  return lines.join("\n").trim();
}

function markdownToBlocks(markdown: string): unknown[] {
  // Minimaler Konverter: paragraph + Headings + List-Items + Quote +
  // Code-Fences + Hrule. Komplexere Strukturen (geschachtelte Listen,
  // Tabellen) bleiben simpel als Paragraphs erhalten.
  const lines = markdown.split(/\r?\n/);
  const blocks: unknown[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      i++;
      continue;
    }
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? "").startsWith("```")) {
        codeLines.push(lines[i] ?? "");
        i++;
      }
      i++; // skip closing fence
      blocks.push({
        object: "block",
        type: "code",
        code: {
          language: lang || "plain text",
          rich_text: [{ type: "text", text: { content: codeLines.join("\n") } }],
        },
      });
      continue;
    }
    if (line.startsWith("# ")) {
      blocks.push(heading("heading_1", line.slice(2)));
    } else if (line.startsWith("## ")) {
      blocks.push(heading("heading_2", line.slice(3)));
    } else if (line.startsWith("### ")) {
      blocks.push(heading("heading_3", line.slice(4)));
    } else if (/^- \[[ x]\]/.test(line)) {
      const match = line.match(/^- \[([ x])\] (.*)$/);
      if (match) {
        blocks.push({
          object: "block",
          type: "to_do",
          to_do: {
            rich_text: [{ type: "text", text: { content: match[2] ?? "" } }],
            checked: match[1] === "x",
          },
        });
      }
    } else if (line.startsWith("- ")) {
      blocks.push({
        object: "block",
        type: "bulleted_list_item",
        bulleted_list_item: {
          rich_text: [{ type: "text", text: { content: line.slice(2) } }],
        },
      });
    } else if (/^\d+\.\s/.test(line)) {
      blocks.push({
        object: "block",
        type: "numbered_list_item",
        numbered_list_item: {
          rich_text: [
            {
              type: "text",
              text: { content: line.replace(/^\d+\.\s/, "") },
            },
          ],
        },
      });
    } else if (line.startsWith("> ")) {
      blocks.push({
        object: "block",
        type: "quote",
        quote: {
          rich_text: [{ type: "text", text: { content: line.slice(2) } }],
        },
      });
    } else if (line.trim() === "---") {
      blocks.push({ object: "block", type: "divider", divider: {} });
    } else {
      blocks.push({
        object: "block",
        type: "paragraph",
        paragraph: {
          rich_text: [{ type: "text", text: { content: line } }],
        },
      });
    }
    i++;
  }
  return blocks;
}

function heading(
  type: "heading_1" | "heading_2" | "heading_3",
  text: string,
): unknown {
  return {
    object: "block",
    type,
    [type]: {
      rich_text: [{ type: "text", text: { content: text } }],
    },
  };
}

function richTextToString(rt: NotionRichText[] | undefined): string {
  if (!rt) return "";
  return rt.map((t) => t.plain_text ?? t.text?.content ?? "").join("");
}

function searchResultToHit(
  r: NotionPage | NotionDatabase,
): KnowledgeSearchHit {
  if (r.object === "database") {
    return {
      id: r.id,
      title: extractDatabaseTitle(r),
      type: "database",
      url: r.url,
    };
  }
  return {
    id: r.id,
    title: extractTitle(r),
    type: "page",
    url: r.url,
  };
}
