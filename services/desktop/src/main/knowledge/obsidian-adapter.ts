// v0.1.235 — Obsidian-Adapter (Phase 3 von PLANS_knowledge_integrations.md).
//
// Spricht mit dem Community-Plugin „Local REST API"
// (https://github.com/coddingtonbear/obsidian-local-rest-api).
// Der Nutzer installiert + aktiviert das Plugin in seinem Vault, holt
// sich aus den Plugin-Settings den API-Key und gibt uns Base-URL +
// Key. Default-Setup:
//
//   Base-URL: http://127.0.0.1:27123   (HTTP-Modus, einfacher)
//   Base-URL: https://127.0.0.1:27124  (HTTPS mit self-signed Cert)
//
// Wir empfehlen HTTP für lokalen Verkehr — TLS auf 127.0.0.1 mit
// self-signed Cert ist mehr Aufwand als Nutzen. Auth ist immer
// Bearer-Token im `Authorization`-Header.
//
// Endpoints, die wir nutzen:
//
//   GET    /                                Server-Info + Auth-Check
//   GET    /vault/{path}                    Datei-Inhalt (Markdown)
//   PUT    /vault/{path}                    Datei erstellen / ersetzen
//   POST   /vault/{path}                    An Datei anhängen
//   DELETE /vault/{path}                    Datei löschen
//   GET    /vault/{folder}/                 Ordner-Listing
//   POST   /search/simple/?query=…          Vault-weite Volltextsuche
//
// Was bewusst NICHT in P3:
//
//   - Frontmatter-Patch (eigener PATCH-Endpoint /vault/{path} mit
//     "Operation: replace", "Target-Type: frontmatter"). Komplexer
//     Header-Tanz, lohnt sich erst wenn es konkret gebraucht wird.
//   - Dataview-Queries via POST /search/. Powerful, aber Dataview
//     muss installiert sein und die Plugin-Antwort-Shape ist eng
//     an Dataview gebunden.
//   - Tags-/Backlinks-Endpoints. Nice-to-have, kein CRM-Use-Case
//     hängt davon.
//   - Schema-Introspection. Obsidian Vaults haben kein zentrales
//     Schema; Frontmatter-Felder ergeben sich aus Konvention.

import type { KnowledgeProviderStatus } from "../../shared/types";
import type {
  KnowledgeAdapter,
  KnowledgeContent,
  KnowledgeItem,
  KnowledgeSchema,
  KnowledgeSearchHit,
  KnowledgeUpdate,
} from "./types";
import { KnowledgeProviderStore } from "./store";

let nfetch: typeof fetch = fetch;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  const undici = require("undici") as { fetch?: typeof fetch };
  if (typeof undici.fetch === "function") nfetch = undici.fetch;
} catch {
  /* keep global */
}

export class ObsidianAdapter implements KnowledgeAdapter {
  readonly kind = "obsidian" as const;
  private readonly store = KnowledgeProviderStore.shared();
  private cachedCreds: { apiKey: string; baseUrl: string } | null = null;

  attach(): void {
    this.store.on("tokenChanged", (kind) => {
      if (kind === "obsidian") this.cachedCreds = null;
    });
  }

  getStatus(): KnowledgeProviderStatus {
    return this.store.statusFor("obsidian");
  }

  /**
   * Connect-Flow: nimmt Credentials entgegen, persistiert sie, und
   * macht einen Auth-Check-Roundtrip gegen GET /. Bei Erfolg setzt
   * sich der Status auf connected + dem Vault-Namen.
   *
   * Der KnowledgeAdapter-Vertrag gibt nur einen `token`-String her.
   * Wir akzeptieren hier denselben, ABER der String wird als
   * JSON-Envelope mit `{apiKey, baseUrl}` interpretiert. Settings-UI
   * + Chat-Tool serialisieren das so. Plain-String (nur Token, ohne
   * URL) → wir nutzen die Default-Base-URL.
   */
  async connect(credentials: {
    token: string;
  }): Promise<KnowledgeProviderStatus> {
    let creds: { apiKey: string; baseUrl: string };
    try {
      const parsed = JSON.parse(credentials.token) as Partial<{
        apiKey: string;
        baseUrl: string;
      }>;
      if (
        typeof parsed.apiKey === "string" &&
        typeof parsed.baseUrl === "string"
      ) {
        creds = { apiKey: parsed.apiKey, baseUrl: parsed.baseUrl };
      } else {
        throw new Error("not a creds envelope");
      }
    } catch {
      // Fallback: Caller hat nur den Token geschickt, keine URL.
      // Wir nutzen die Default-Base-URL. UI sollte das aber nie
      // tun — der Pfad existiert defensiv.
      creds = {
        apiKey: credentials.token.trim(),
        baseUrl: "http://127.0.0.1:27123",
      };
    }

    this.store.setObsidianCredentials(creds);
    this.cachedCreds = creds;

    try {
      const info = await this.request<{
        authenticated?: boolean;
        ok?: string;
        service?: string;
        versions?: { obsidian?: string };
      }>("/");
      const display =
        info.service ?? `Obsidian Vault @ ${creds.baseUrl}`;
      return this.store.updateStatus("obsidian", {
        connected: true,
        displayName: display,
        errorMessage: null,
        lastSyncAt: new Date().toISOString(),
      });
    } catch (err) {
      const message = humanizeObsidianError(err);
      this.store.updateStatus("obsidian", {
        connected: false,
        errorMessage: message,
      });
      throw new Error(message);
    }
  }

  async disconnect(): Promise<void> {
    this.cachedCreds = null;
    this.store.clearToken("obsidian");
  }

  async search(
    query: string,
    opts?: { limit?: number },
  ): Promise<KnowledgeSearchHit[]> {
    const limit = opts?.limit ?? 25;
    // /search/simple/?query=…&contextLength=… returns Array<{filename,
    // matches: [{ match: {start, end}, context }]}>
    const path = `/search/simple/?query=${encodeURIComponent(query)}&contextLength=100`;
    const res = await this.request<
      Array<{
        filename: string;
        score?: number;
        matches?: Array<{ context?: string }>;
      }>
    >(path, "POST");
    return (res ?? []).slice(0, limit).map((hit) => ({
      id: hit.filename,
      title: pathToTitle(hit.filename),
      snippet:
        hit.matches && hit.matches.length > 0
          ? (hit.matches[0]?.context ?? "").slice(0, 200)
          : undefined,
      type: "note",
    }));
  }

  async getItem(id: string): Promise<KnowledgeItem> {
    // Plugin returnt bei `Accept: application/json` ein Envelope mit
    // content + frontmatter; bei text/markdown nur die rohe Datei.
    // JSON-Envelope ist uns lieber.
    const body = await this.request<{
      content?: string;
      frontmatter?: Record<string, unknown>;
      stat?: { ctime?: number; mtime?: number };
      path?: string;
      tags?: string[];
    }>(`/vault/${encodePath(id)}`, "GET", undefined, {
      accept: "application/vnd.olrapi.note+json",
    });
    return {
      id,
      title: pathToTitle(id),
      content: body.content ?? "",
      properties: body.frontmatter ?? undefined,
      createdAt:
        body.stat?.ctime !== undefined
          ? new Date(body.stat.ctime).toISOString()
          : undefined,
      updatedAt:
        body.stat?.mtime !== undefined
          ? new Date(body.stat.mtime).toISOString()
          : undefined,
    };
  }

  async updateItem(
    id: string,
    patch: KnowledgeUpdate,
  ): Promise<KnowledgeItem> {
    if (patch.properties && Object.keys(patch.properties).length > 0) {
      throw new Error(
        "Frontmatter-Updates sind in Phase 3 noch nicht unterstützt. " +
          "Bitte stattdessen `appendContent` oder `replaceContent` nutzen.",
      );
    }
    if (patch.appendContent && patch.appendContent.trim().length > 0) {
      // POST /vault/{path} mit Markdown-Body hängt an. Plugin
      // erwartet `Content-Type: text/markdown`.
      await this.request(
        `/vault/${encodePath(id)}`,
        "POST",
        patch.appendContent,
        {
          "content-type": "text/markdown",
        },
      );
    }
    if (patch.replaceContent !== undefined) {
      await this.request(
        `/vault/${encodePath(id)}`,
        "PUT",
        patch.replaceContent,
        {
          "content-type": "text/markdown",
        },
      );
    }
    return this.getItem(id);
  }

  async createItem(
    parent: string | null,
    content: KnowledgeContent,
  ): Promise<KnowledgeItem> {
    if (!content.title || content.title.trim().length === 0) {
      throw new Error(
        "Obsidian-Note braucht einen Titel — der wird zum Dateinamen.",
      );
    }
    const folder = (parent ?? "").replace(/^\/+|\/+$/g, "");
    const safeName = content.title
      .replace(/[/\\:*?"<>|]/g, " ")
      .trim();
    const path = folder
      ? `${folder}/${safeName}.md`
      : `${safeName}.md`;
    const body = content.content ?? "";
    await this.request(`/vault/${encodePath(path)}`, "PUT", body, {
      "content-type": "text/markdown",
    });
    return this.getItem(path);
  }

  /**
   * Obsidian hat kein zentrales Schema — Vault-weit gibt es keine
   * vorgeschriebenen Frontmatter-Felder. Wir liefern ein Placeholder-
   * Schema zurück, das dem Caller klarmacht, dass Schema-Introspection
   * hier konzeptionell nicht greift.
   */
  async introspectSchema(
    containerId?: string | null,
  ): Promise<KnowledgeSchema> {
    return {
      containerId: containerId ?? null,
      containerTitle: containerId ?? "Vault",
      properties: [],
    };
  }

  /**
   * Listet alle Dateien in einem Ordner (oder Vault-Root wenn null).
   * Wird vom Chat-Tool `obsidian_list_notes` genutzt, ist nicht Teil
   * des KnowledgeAdapter-Interfaces.
   */
  async listFolder(folder: string | null): Promise<
    Array<{ path: string; isFolder: boolean }>
  > {
    const p = folder ? folder.replace(/^\/+|\/+$/g, "") + "/" : "";
    const res = await this.request<{ files?: string[] }>(
      `/vault/${encodePath(p)}`,
    );
    const entries = res.files ?? [];
    return entries.map((entry) => {
      const isFolder = entry.endsWith("/");
      const stripped = isFolder ? entry.slice(0, -1) : entry;
      const fullPath = p + stripped + (isFolder ? "/" : "");
      return { path: fullPath, isFolder };
    });
  }

  // ---- internals -----------------------------------------------------------

  private async ensureCreds(): Promise<{ apiKey: string; baseUrl: string }> {
    if (this.cachedCreds) return this.cachedCreds;
    const creds = await this.store.getObsidianCredentials();
    if (!creds) {
      throw new Error(
        "Obsidian ist nicht verbunden. Bitte zuerst über " +
          "`obsidian_connect_start` oder Einstellungen → Wissensquellen " +
          "verbinden.",
      );
    }
    this.cachedCreds = creds;
    return creds;
  }

  private async request<T>(
    path: string,
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" = "GET",
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<T> {
    const creds = await this.ensureCreds();
    const url = creds.baseUrl + path;
    const headers: Record<string, string> = {
      authorization: `Bearer ${creds.apiKey}`,
      accept: "application/json",
      ...(extraHeaders ?? {}),
    };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      if (typeof body === "string") {
        init.body = body;
      } else {
        if (!headers["content-type"]) {
          headers["content-type"] = "application/json";
        }
        init.body = JSON.stringify(body);
      }
    }
    let res: Response;
    try {
      res = await nfetch(url, init);
    } catch (err) {
      // Network-level failure → wrap als ObsidianApiError so
      // humanizeObsidianError den Spezialfall (ECONNREFUSED etc.)
      // erkennt.
      throw new ObsidianNetworkError(
        err instanceof Error ? err.message : String(err),
        creds.baseUrl,
      );
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ObsidianApiError(res.status, text);
    }
    // Manche Endpoints liefern Text statt JSON (z. B. /vault/{path}
    // mit Accept: text/markdown). Wir parsen JSON nur wenn passend.
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.startsWith("application/json")) {
      return (await res.json()) as T;
    }
    if (contentType.includes("application/vnd.olrapi")) {
      return (await res.json()) as T;
    }
    // Sonst: Text/Markdown — Caller weiß das.
    return (await res.text()) as unknown as T;
  }
}

class ObsidianApiError extends Error {
  constructor(public status: number, public body: string) {
    super(`Obsidian REST API ${status}: ${body.slice(0, 200)}`);
  }
}

class ObsidianNetworkError extends Error {
  constructor(message: string, public baseUrl: string) {
    super(`Network error to ${baseUrl}: ${message}`);
  }
}

function humanizeObsidianError(err: unknown): string {
  if (err instanceof ObsidianApiError) {
    if (err.status === 401) {
      return "Obsidian lehnt den API-Key ab (HTTP 401). Bitte in Obsidian → Settings → Local REST API einen neuen Key generieren und hier eintragen.";
    }
    if (err.status === 403) {
      return "Obsidian verweigert den Zugriff (HTTP 403). Plugin-Settings prüfen — eventuell ist eine Hostname-Allowlist gesetzt.";
    }
    if (err.status === 404) {
      return "Der angefragte Pfad wurde im Vault nicht gefunden (HTTP 404).";
    }
    return `Obsidian-Fehler: ${err.message}`;
  }
  if (err instanceof ObsidianNetworkError) {
    if (/ECONNREFUSED/i.test(err.message)) {
      return `Verbindung zu ${err.baseUrl} verweigert. Läuft Obsidian + ist das Plugin „Local REST API" aktiviert? Default-Port ist 27123 (HTTP) bzw. 27124 (HTTPS).`;
    }
    if (
      /self.?signed certificate|cert/i.test(err.message) &&
      err.baseUrl.startsWith("https")
    ) {
      return `TLS-Fehler gegen ${err.baseUrl}. Das Plugin nutzt ein selbst-signiertes Zertifikat. Empfehlung: in den Plugin-Settings den HTTP-Port (Standard 27123) aktivieren und stattdessen http://127.0.0.1:27123 als Base-URL eintragen.`;
    }
    return `Netzwerkfehler gegen ${err.baseUrl}: ${err.message}. Plugin-Status prüfen.`;
  }
  return err instanceof Error ? err.message : String(err);
}

// ---- Helpers ----------------------------------------------------------------

function pathToTitle(path: string): string {
  // "Folder/Sub/My Note.md" → "My Note"
  const last = path.split("/").pop() ?? path;
  return last.replace(/\.md$/i, "");
}

function encodePath(path: string): string {
  // Per-Segment encoding damit `/` als Pfad-Trenner intakt bleibt,
  // alles andere (Leerzeichen, Sonderzeichen, Umlaute) escapen.
  return path
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}
