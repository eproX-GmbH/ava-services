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
    // v0.1.296 — Phase 4: Frontmatter-Patch via Local-REST-API.
    // Verwendet PATCH /vault/{path} mit den plugin-spezifischen Headers
    // Operation/Target-Type/Target. Pro Frontmatter-Key ein Call (das
    // Plugin akzeptiert pro PATCH nur EIN Target). Verify-After durch
    // Re-Read der frontmatter aus dem JSON-Envelope.
    let frontmatterWarnings: string[] = [];
    let frontmatterDiagnostics:
      | {
          requested: Record<string, unknown>;
          before?: Record<string, unknown>;
          after?: Record<string, unknown>;
          patchedKeys: string[];
        }
      | undefined;
    if (patch.properties && Object.keys(patch.properties).length > 0) {
      const verifyResult = await this.patchFrontmatter(id, patch.properties);
      frontmatterWarnings = verifyResult.warnings;
      frontmatterDiagnostics = verifyResult.diagnostics;
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
    const item = await this.getItem(id);
    // v0.1.296 — Warnings + Diagnostics ans Item heben, damit der Tool-
    // Wrapper sie auf Top-Level für den Agent sichtbar machen kann.
    if (frontmatterWarnings.length > 0 || frontmatterDiagnostics) {
      const enriched = item as KnowledgeItem & {
        warnings?: string[];
        diagnostics?: unknown;
      };
      if (frontmatterWarnings.length > 0) {
        enriched.warnings = frontmatterWarnings;
      }
      if (frontmatterDiagnostics) {
        enriched.diagnostics = frontmatterDiagnostics;
      }
    }
    return item;
  }

  /**
   * v0.1.296 — Frontmatter-Patch via Local-REST-API.
   *
   * Local-REST-API hat einen PATCH-Endpoint mit speziellen Headers:
   *   PATCH /vault/{path}
   *   Operation: replace
   *   Target-Type: frontmatter
   *   Target: <key-name>             // URL-encoded
   *   Content-Type: application/json
   *   Body: JSON-encoded value
   *
   * Das Plugin nimmt pro PATCH GENAU EIN Target — wir loopen also über
   * alle requested Keys. Wenn ein Key noch nicht im Frontmatter
   * existiert, legt das Plugin ihn an (Create-Target-If-Missing: true
   * ist Default in den Plugin-Versionen die wir unterstützen).
   *
   * Verify-After: GET zurücklesen, requested vs. tatsächlich
   * vergleichen. Klassischer Notion-Bug-Klon: Plugin kann 200 OK
   * antworten ohne zu schreiben (z. B. wenn Vault-Pfad case-sensitive
   * abweicht oder API-Key nur Read-Scope hat).
   */
  private async patchFrontmatter(
    pageId: string,
    properties: Record<string, unknown>,
  ): Promise<{
    warnings: string[];
    diagnostics: {
      requested: Record<string, unknown>;
      before?: Record<string, unknown>;
      after?: Record<string, unknown>;
      patchedKeys: string[];
    };
  }> {
    const warnings: string[] = [];
    // Snapshot vorher.
    const before = await this.getItem(pageId);
    const beforeFm = (before.properties ?? {}) as Record<string, unknown>;
    const patchedKeys: string[] = [];
    for (const [key, value] of Object.entries(properties)) {
      // Target-Header muss URL-encoded sein, weil Header-Werte
      // bestimmte Sonderzeichen (Komma, Doppelpunkt, etc.) nicht
      // tragen können. Plugin macht URL-decode wieder rückgängig.
      const encodedTarget = encodeURIComponent(key);
      console.info(
        `[obsidian-adapter] PATCH frontmatter path=${pageId} key=${key} ` +
          `value=${JSON.stringify(value).slice(0, 200)}`,
      );
      try {
        await this.request(
          `/vault/${encodePath(pageId)}`,
          "PATCH",
          // Wert wird vom Plugin als JSON erwartet — also explizit
          // stringify (auch für Strings: "Aktiv" wird zu "\"Aktiv\"").
          JSON.stringify(value),
          {
            operation: "replace",
            "target-type": "frontmatter",
            target: encodedTarget,
            "content-type": "application/json",
            // v0.1.296 — neue Keys anlegen falls noch nicht da. Default
            // ist plugin-version-abhängig; explizit setzen ist sicherer.
            "create-target-if-missing": "true",
          },
        );
        patchedKeys.push(key);
      } catch (err) {
        warnings.push(
          `Frontmatter-Key "${key}" konnte nicht gesetzt werden: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    // Verify-After.
    const after = await this.getItem(pageId);
    const afterFm = (after.properties ?? {}) as Record<string, unknown>;
    const failures: string[] = [];
    for (const [key, requested] of Object.entries(properties)) {
      const actual = afterFm[key];
      if (!frontmatterValuesMatch(requested, actual)) {
        failures.push(
          `"${key}" (angefragt: ${formatValueForError(requested)}, tatsächlich: ${formatValueForError(actual)})`,
        );
      }
    }
    // v0.1.297 — Defensive Kopie. Wenn der Caller die properties-Map
    // nach dem Call mutiert, soll unser Diagnostics-Snapshot stabil
    // bleiben.
    const diagnostics = {
      requested: { ...properties },
      before: beforeFm,
      after: afterFm,
      patchedKeys,
    };
    if (failures.length > 0) {
      throw new Error(
        `Obsidian hat den Frontmatter-PATCH akzeptiert (HTTP 200), aber ` +
          `folgende Keys wurden nicht übernommen: ${failures.join("; ")}. ` +
          `Mögliche Ursachen: ` +
          `(a) API-Key hat nur Read-Scope — in Plugin-Settings checken; ` +
          `(b) Vault-Pfad case-sensitive vertippt; ` +
          `(c) Local-REST-API-Version zu alt (PATCH /vault wurde später ergänzt, mindestens v3.x nötig).` +
          (warnings.length > 0 ? ` Hinweise: ${warnings.join("; ")}.` : ""),
      );
    }
    return { warnings, diagnostics };
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
  /**
   * v0.1.296 — Note aus dem Vault löschen via DELETE /vault/{path}.
   *
   * Achtung: Obsidian Local-REST-API hat KEIN Trash-Konzept — die
   * Datei ist nach DELETE weg (außer der User hat einen separaten
   * Obsidian-Trash-Plugin aktiv, der File-Operations watcht, oder
   * sein OS hat einen Filesystem-Papierkorb der das automatisch
   * abfängt — Mac/Finder-Trash funktioniert NICHT, weil das Plugin
   * direkt fs.unlink macht). Confirm-Gate im Tool-Layer ist deshalb
   * Pflicht.
   *
   * Verify-After: Anschließend GET → 404 erwartet. Bei 200 (Datei
   * existiert noch) werfen wir, damit der Caller den User auf
   * Plugin-Permission-Probleme hinweisen kann.
   */
  async deleteItem(id: string): Promise<void> {
    console.info(`[obsidian-adapter] DELETE /vault/${id}`);
    await this.request(`/vault/${encodePath(id)}`, "DELETE");
    // Verify-After.
    let stillExists = false;
    try {
      await this.request<unknown>(`/vault/${encodePath(id)}`, "GET", undefined, {
        accept: "application/vnd.olrapi.note+json",
      });
      stillExists = true;
    } catch (err) {
      if (err instanceof ObsidianApiError && err.status === 404) {
        // Perfekt — Datei ist weg.
        return;
      }
      // Anderer Fehler (Network etc.) — wir wissen nicht, ob's gelöscht
      // wurde. Best-effort: laufen lassen, der DELETE-Call war erfolgreich.
      console.warn(
        `[obsidian-adapter] DELETE verify-after probe failed (non-404): ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    if (stillExists) {
      throw new Error(
        `Obsidian hat den DELETE-Call akzeptiert (HTTP 200), aber die Datei ` +
          `"${id}" existiert immer noch. Mögliche Ursachen: ` +
          `(a) API-Key hat keinen Write-Scope — Plugin-Settings prüfen; ` +
          `(b) Plugin-Version zu alt für DELETE; ` +
          `(c) Vault-Permission-Konflikt (read-only Datei).`,
      );
    }
  }

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

  /**
   * v0.1.297 — Folder-Schema-Introspection.
   *
   * Obsidian-Vaults haben kein zentrales Schema, aber in der Praxis
   * folgen Notizen INNERHALB EINES ORDNERS einer Konvention (z. B.
   * `CRM/*.md` haben alle die Felder Name, Status, Stage, Follow-Up).
   * Wir scannen bis zu `sampleSize` Notes im Ordner parallel, sammeln
   * deren Frontmatter-Keys ein, inferieren Werte-Typen und liefern
   * pro Key ein paar Beispiel-Werte zurück.
   *
   * Damit hat der Agent vor dem `update_frontmatter` eine Notion-
   * artige Schema-Übersicht: welche Keys existieren überhaupt, was
   * sind ihre Typen, was sind übliche Werte. Statt vorher eine
   * zufällige Note zu laden und zu raten.
   */
  async introspectFolder(
    folder: string,
    opts?: { sampleSize?: number },
  ): Promise<{
    folder: string;
    notesScanned: number;
    keys: Array<{
      name: string;
      types: string[];
      occurrences: number;
      sampleValues: unknown[];
    }>;
  }> {
    const sampleSize = Math.min(Math.max(opts?.sampleSize ?? 20, 1), 50);
    const entries = await this.listFolder(folder);
    const noteEntries = entries
      .filter((e) => !e.isFolder && /\.md$/i.test(e.path))
      .slice(0, sampleSize);
    if (noteEntries.length === 0) {
      return { folder, notesScanned: 0, keys: [] };
    }
    // Parallel laden — getItem ist read-only und der Plugin-Server kann
    // gut parallele GETs. Bei 20 Notes mit ~10ms RTT sind das 20 Calls
    // statt 20×10 = 200ms sequential.
    const items = await Promise.all(
      noteEntries.map((e) =>
        this.getItem(e.path).catch(() => null),
      ),
    );
    const keyAgg = new Map<
      string,
      { types: Set<string>; occurrences: number; sampleValues: unknown[] }
    >();
    for (const item of items) {
      if (!item || !item.properties) continue;
      for (const [key, value] of Object.entries(item.properties)) {
        if (!keyAgg.has(key)) {
          keyAgg.set(key, {
            types: new Set(),
            occurrences: 0,
            sampleValues: [],
          });
        }
        const agg = keyAgg.get(key)!;
        agg.occurrences += 1;
        agg.types.add(inferFrontmatterType(value));
        // bis zu 3 unique sample-Werte sammeln
        if (
          agg.sampleValues.length < 3 &&
          !agg.sampleValues.some((v) => deepEqualSimple(v, value))
        ) {
          agg.sampleValues.push(value);
        }
      }
    }
    const keys = Array.from(keyAgg.entries())
      .map(([name, agg]) => ({
        name,
        types: Array.from(agg.types).sort(),
        occurrences: agg.occurrences,
        sampleValues: agg.sampleValues,
      }))
      // Sortiere nach Häufigkeit absteigend — die wichtigsten Keys oben.
      .sort((a, b) => b.occurrences - a.occurrences);
    return {
      folder,
      notesScanned: items.filter((i) => i !== null).length,
      keys,
    };
  }

  /**
   * v0.1.297 — Tag-Endpoints des Plugins.
   * GET /tags                     → alle Tags im Vault + count
   * GET /tags/{tagname}           → Notes mit einem Tag
   */
  async listTags(): Promise<Array<{ tag: string; count: number }>> {
    type Resp = { tags?: Array<{ tag: string; count: number }> };
    const res = await this.request<Resp>("/tags/");
    return res.tags ?? [];
  }

  async searchByTag(tag: string): Promise<KnowledgeSearchHit[]> {
    // Tag mit oder ohne führendes # akzeptieren — der Plugin-Endpoint
    // erwartet kein #-Prefix im Pfad-Segment.
    const cleanTag = tag.startsWith("#") ? tag.slice(1) : tag;
    type Resp = {
      files?: Array<{ path: string; title?: string; matches?: unknown[] }>;
    };
    const res = await this.request<Resp>(
      `/tags/${encodeURIComponent(cleanTag)}/`,
    );
    const files = res.files ?? [];
    return files.map((f) => ({
      id: f.path,
      title: f.title ?? pathToTitle(f.path),
      snippet: undefined,
      url: undefined,
    }));
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

/**
 * v0.1.296 — Tolerant value-match für Frontmatter-Verify-After. YAML
 * round-trips können String-Werte als String zurückgeben, Booleans als
 * Bool, Datums-Strings unverändert. Wir behandeln:
 *   - String case-insensitive + trim
 *   - Number toleranz
 *   - Array order-insensitive
 *   - sonst deepEqual
 */
function frontmatterValuesMatch(
  requested: unknown,
  actual: unknown,
): boolean {
  if (requested === actual) return true;
  if (requested == null || actual == null) return requested === actual;
  if (typeof requested === "string" && typeof actual === "string") {
    // v0.1.297 — Date-Prefix-Match: Wenn der User "2026-07-16" setzt
    // und YAML das als Datum interpretiert, kommt es evtl. mit
    // Timezone-Suffix zurück ("2026-07-16T00:00:00.000Z"). Toleriere
    // das wenn die ersten 10 Zeichen (YYYY-MM-DD) übereinstimmen.
    if (
      /^\d{4}-\d{2}-\d{2}/.test(requested) &&
      actual.startsWith(requested.slice(0, 10))
    ) {
      return true;
    }
    return requested.trim().toLowerCase() === actual.trim().toLowerCase();
  }
  if (typeof requested === "number" && typeof actual === "number") {
    return Math.abs(requested - actual) < 1e-9;
  }
  if (typeof requested === "boolean" && typeof actual === "boolean") {
    return requested === actual;
  }
  if (Array.isArray(requested) && Array.isArray(actual)) {
    if (requested.length !== actual.length) return false;
    const req = [...requested].map((v) => String(v).trim().toLowerCase()).sort();
    const act = [...actual].map((v) => String(v).trim().toLowerCase()).sort();
    return req.every((v, i) => v === act[i]);
  }
  // Fallback: JSON-Vergleich. Cheap-and-good-enough für nested objects.
  try {
    return JSON.stringify(requested) === JSON.stringify(actual);
  } catch {
    return false;
  }
}

/**
 * v0.1.297 — Cheap type-inference für Frontmatter-Werte. Returnt einen
 * Stringnamen ("string", "number", "boolean", "array", "object",
 * "null", "date"), den der Agent im Schema-Hint zeigen kann.
 */
function inferFrontmatterType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "string") {
    if (/^\d{4}-\d{2}-\d{2}/.test(v)) return "date";
    return "string";
  }
  if (typeof v === "number") return "number";
  if (typeof v === "boolean") return "boolean";
  if (v instanceof Date) return "date";
  return typeof v; // "object", "undefined", "function" (last unlikely)
}

/** v0.1.297 — strict equality + JSON-fallback. Reicht für Sample-Dedup. */
function deepEqualSimple(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

function formatValueForError(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") return `"${v}"`;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
