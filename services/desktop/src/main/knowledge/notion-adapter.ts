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

    // v0.1.232 — Pre-Flight-Check für die Page-Struktur.
    //
    // Hintergrund: Notion-Search liefert workspace-weit alles, was zum
    // Query passt — auch Sub-Pages, Notizen, Linked-Database-Views.
    // Wenn der Agent versehentlich eine SUB-PAGE updated statt der
    // echten Database-Row, scheint der Call zu funktionieren (200 OK,
    // Page existiert), aber der CRM-Eintrag bleibt unverändert weil
    // die Sub-Page ein eigenständiges Objekt ist.
    //
    // Wir holen die Page einmal vorab, schauen auf parent.type, und
    // werfen bei Mismatch (parent nicht database_id + Non-Title-
    // Properties angefragt) einen klaren Fehler mit Parent-Kontext
    // damit der Agent self-healen oder den Nutzer informieren kann.
    if (patch.properties && Object.keys(patch.properties).length > 0) {
      const preflight = await this.request<NotionPage>(
        `/v1/pages/${encodeURIComponent(id)}`,
      );
      console.info(
        `[notion-adapter] updateItem pre-flight: pageId=${id} ` +
          `parent.type=${preflight.parent.type} ` +
          `database_id=${preflight.parent.database_id ?? "—"} ` +
          `url=${preflight.url ?? "—"}`,
      );
      const requestedNames = Object.keys(patch.properties);
      const onlyTitleRequested =
        requestedNames.length === 1 && requestedNames[0] === "title";
      if (preflight.parent.type !== "database_id" && !onlyTitleRequested) {
        // Hilfreiche Diagnose: was IST die Page eigentlich?
        let parentHint = "";
        if (
          preflight.parent.type === "page_id" &&
          preflight.parent.page_id
        ) {
          try {
            const parent = await this.request<NotionPage>(
              `/v1/pages/${encodeURIComponent(preflight.parent.page_id)}`,
            );
            parentHint = ` Diese Page liegt UNTER einer anderen Page (Eltern-Titel: "${extractTitle(parent)}"), nicht in einer Database.`;
          } catch {
            parentHint = ` Diese Page liegt unter einer Page-Hierarchie, nicht in einer Database.`;
          }
        } else if (preflight.parent.type === "workspace") {
          parentHint = ` Diese Page liegt direkt im Workspace, nicht in einer Database.`;
        }
        throw new Error(
          `Die angegebene Page (id=${id}) ist KEINE Database-Zeile — ` +
            `Properties wie ${requestedNames.join(", ")} können hier nicht gesetzt werden.${parentHint} ` +
            `Notion-Search liefert manchmal Sub-Pages oder Notizen mit demselben Titel zurück, statt der echten DB-Zeile. ` +
            `Bitte stattdessen \`notion_query_database\` mit dem passenden Filter nutzen, ` +
            `um die korrekte Zeile zu finden. Die Page-URL des aktuellen Targets: ${preflight.url ?? "?"}`,
        );
      }
    }

    // v0.1.245 — Property-Namen früh auf canonical Schema-Namen mappen,
    // damit Snapshot, Patch und Verify alle DIE GLEICHEN Keys benutzen.
    // Sonst läuft (snapshot, verify) mit Nutzer-Namen ("Follow-Up"),
    // patch mit Schema-Namen ("Follow-Up (Datum)") und der Verify-Step
    // schlägt false-negative an, obwohl Notion korrekt geschrieben hat.
    let canonicalPatchProperties: Record<string, unknown> | undefined;
    let nameRemap: Record<string, string> = {};
    if (patch.properties && Object.keys(patch.properties).length > 0) {
      // Schema für die Property-Namen-Auflösung holen. (Das gleiche
      // Schema wird unten in convertPropertiesForPatch nochmal gelesen
      // — das ist OK, Notion antwortet schnell und der Request ist
      // billig.)
      try {
        const page = await this.request<NotionPage>(
          `/v1/pages/${encodeURIComponent(id)}`,
        );
        if (page.parent.type === "database_id" && page.parent.database_id) {
          const db = await this.request<NotionDatabase>(
            `/v1/databases/${encodeURIComponent(page.parent.database_id)}`,
          );
          canonicalPatchProperties = {};
          for (const [k, v] of Object.entries(patch.properties)) {
            const canonical = resolvePropertyName(k, db.properties) ?? k;
            canonicalPatchProperties[canonical] = v;
            if (canonical !== k) nameRemap[k] = canonical;
          }
        }
      } catch {
        // Schema-Read scheitert → wir lassen patch.properties unverändert.
        // convertPropertiesForPatch fängt das später nochmal auf.
      }
    }
    const effectivePatchProperties =
      canonicalPatchProperties ?? patch.properties;

    // v0.1.231 — Snapshot vor dem PATCH machen, damit wir hinterher
    // den Schreib-Erfolg verifizieren können. Sonst geben wir
    // fälschlich Erfolg zurück, wenn Notion still no-opt
    // (Property-Name unbekannt, Status-Option existiert nicht, RO-
    // Integration etc.).
    const beforeProps = effectivePatchProperties
      ? await this.snapshotProperties(id, Object.keys(effectivePatchProperties))
      : null;
    let propertyConversionWarnings: string[] = [];
    let droppedProperties: string[] = [];
    // v0.1.237 — Notions PATCH /v1/pages/:id-Antwort enthält das volle
    // Page-Objekt mit den ECHTEN Post-Write-Properties. Vorher haben
    // wir das Ergebnis verworfen und stattdessen direkt danach getItem()
    // aufgerufen — das läuft aber durch Notions eventually-consistent
    // Cache und kann den OLD-State zurückgeben. Resultat: verify-after
    // hat manchmal falsch alarmiert oder (schlimmer) Erfolg vorgegaukelt.
    // Jetzt nehmen wir die PATCH-Antwort als autoritative Quelle.
    let patchResponse: NotionPage | null = null;
    if (
      effectivePatchProperties &&
      Object.keys(effectivePatchProperties).length > 0
    ) {
      const conversion = await this.convertPropertiesForPatch(
        id,
        effectivePatchProperties,
      );
      propertyConversionWarnings = conversion.warnings;
      // Welche der angefragten Properties wurden vom Schema-Mapper
      // gedroppt? (Property-Name nicht im DB-Schema.) Diese müssen
      // wir DEM AGENT EXPLIZIT melden, sonst hält er einen Drop für
      // einen Erfolg.
      droppedProperties = Object.keys(effectivePatchProperties).filter(
        (name) => !(name in conversion.propsForApi),
      );
      if (Object.keys(conversion.propsForApi).length === 0) {
        throw new Error(
          `Keine der angefragten Properties konnte auf das Datenbank-Schema gemappt werden. ` +
            `Angefragt: ${Object.keys(effectivePatchProperties).join(", ")}. ` +
            `Nutze \`notion_introspect_database\` um die exakten Property-Namen zu sehen.` +
            (propertyConversionWarnings.length > 0
              ? ` Details: ${propertyConversionWarnings.join("; ")}`
              : ""),
        );
      }
      console.info(
        `[notion-adapter] PATCH /v1/pages/${id} properties=${Object.keys(conversion.propsForApi).join(",")}` +
          (propertyConversionWarnings.length > 0
            ? ` warnings=[${propertyConversionWarnings.join(" | ")}]`
            : ""),
      );
      patchResponse = await this.request<NotionPage>(
        `/v1/pages/${encodeURIComponent(id)}`,
        "PATCH",
        { properties: conversion.propsForApi },
      );
    }
    if (patch.appendContent && patch.appendContent.trim().length > 0) {
      const children = markdownToBlocks(patch.appendContent);
      await this.request(
        `/v1/blocks/${encodeURIComponent(id)}/children`,
        "PATCH",
        { children },
      );
    }

    // v0.1.231 — Verify-After: Vergleichen ob die angeforderten
    // Werte WIRKLICH in Notion gelandet sind. Wenn nicht, werfen
    // wir einen handfesten Fehler — sonst behauptet das Tool
    // Erfolg, obwohl in Notion nichts geändert wurde.
    if (effectivePatchProperties && beforeProps) {
      // v0.1.237 — Autoritative Quelle ist die PATCH-Antwort selbst,
      // nicht ein nachgelagertes getItem(). Falls patch.properties leer
      // war (kein PATCH gefeuert), nutzen wir das Snapshot wieder
      // (kein verify nötig).
      const afterProps = patchResponse
        ? simplifyProperties(patchResponse.properties)
        : beforeProps;
      const failures = this.verifyPatchedProperties(
        effectivePatchProperties,
        beforeProps,
        afterProps,
      );
      if (failures.length > 0) {
        const warningSuffix =
          propertyConversionWarnings.length > 0
            ? ` Schema-Mapping-Warnungen: ${propertyConversionWarnings.join("; ")}.`
            : "";
        throw new Error(
          `Notion hat den Update-Call akzeptiert, aber die folgenden Properties wurden NICHT übernommen: ` +
            failures.join("; ") +
            `. Mögliche Ursachen: (1) Property-Name passt nicht exakt zur DB-Spalte, ` +
            `(2) bei Select/Status: gewählte Option existiert nicht im Schema (Tipp: erst notion_introspect_database aufrufen, um die exakten Options zu sehen — Notion ist case-sensitive), ` +
            `(3) Integration hat keine Update-Rechte auf dieser Seite (Notion → Page → Connections prüfen).` +
            warningSuffix,
        );
      }
    }

    // v0.1.237 — Body via separater getItem() weil PATCH-Antwort
    // nur die Properties + Metadaten, nicht den Block-Tree liefert.
    // Properties dann mit der PATCH-Antwort überschreiben, damit der
    // Agent NICHT versehentlich stale Cache-Werte sieht.
    const fresh = await this.getItem(id);
    if (patchResponse) {
      fresh.properties = simplifyProperties(patchResponse.properties);
      fresh.updatedAt = patchResponse.last_edited_time;
    }

    // v0.1.237 — Auch ohne Verify-Fail kann es Warnungen geben (z. B.
    // gedroppte Properties wegen Name-Mismatch, oder Select-Optionen,
    // die zwar via Notions Auto-Create durchgingen, aber dem User
    // vielleicht gar nicht so geplant waren). Die hängen wir an das
    // Item dran, sodass das Tool sie an den Agent zurückreicht.
    const allWarnings: string[] = [];
    if (droppedProperties.length > 0) {
      allWarnings.push(
        `Diese Properties wurden NICHT geupdated, weil sie nicht im DB-Schema existieren: ${droppedProperties.join(", ")}. Tipp: erst notion_introspect_database aufrufen, um die korrekten Spaltennamen zu sehen.`,
      );
    }
    // v0.1.245 — Fuzzy-Remap-Hinweise so der Agent die exakten
    // Schema-Namen lernt.
    const remappedEntries = Object.entries(nameRemap);
    if (remappedEntries.length > 0) {
      allWarnings.push(
        `Property-Namen via Fuzzy-Match korrigiert: ` +
          remappedEntries
            .map(([from, to]) => `"${from}" → "${to}"`)
            .join(", ") +
          `. Beim nächsten Mal bitte die exakten Schema-Namen verwenden.`,
      );
    }
    if (propertyConversionWarnings.length > 0) {
      allWarnings.push(...propertyConversionWarnings);
    }
    if (allWarnings.length > 0) {
      fresh.warnings = allWarnings;
    }
    return fresh;
  }

  /**
   * v0.1.231 — Liest die aktuellen Werte der angefragten Properties,
   * damit wir nach dem PATCH vergleichen können. Verwendet die
   * simplifyPropertyValue-Form (flat values), die auch das gewohnte
   * `KnowledgeItem.properties`-Format liefert.
   */
  private async snapshotProperties(
    pageId: string,
    propertyNames: string[],
  ): Promise<Record<string, unknown>> {
    const page = await this.request<NotionPage>(
      `/v1/pages/${encodeURIComponent(pageId)}`,
    );
    const out: Record<string, unknown> = {};
    for (const name of propertyNames) {
      const p = page.properties[name];
      out[name] = p ? simplifyPropertyValue(p) : undefined;
    }
    return out;
  }

  /**
   * v0.1.231 — Vergleicht angefragte vs. tatsächliche Werte nach
   * dem PATCH. Returnt eine Liste der Property-Namen die NICHT
   * geändert wurden (entweder weil sie identisch zum Pre-Wert
   * blieben oder weil der neue Wert nicht zum angefragten passt).
   *
   * Property-Vergleich ist tolerant: Strings werden case-insensitive
   * verglichen (Notion kann z. B. Status-Namen normalisieren), Datums-
   * Strings werden als ISO-Prefix gematcht.
   */
  private verifyPatchedProperties(
    requested: Record<string, unknown>,
    before: Record<string, unknown>,
    after: Record<string, unknown>,
  ): string[] {
    const failures: string[] = [];
    for (const [name, requestedValue] of Object.entries(requested)) {
      const beforeValue = before[name];
      const afterValue = after[name];

      // Property existiert gar nicht in After → ignorieren (kann sein
      // dass der Name nicht zum Schema passte; das wurde oben bei
      // empty propsForApi schon abgefangen, hier wäre es ein
      // teilweiser Mismatch).
      if (afterValue === undefined) {
        failures.push(
          `"${name}" (Property nicht im Schema; angefragt: ${formatValueForError(requestedValue)})`,
        );
        continue;
      }

      // Wenn der Wert vorher === nachher ist UND wir wollten ihn
      // ändern auf etwas Anderes → Fehlschlag.
      if (
        deepEqual(beforeValue, afterValue) &&
        !valuesMatch(requestedValue, afterValue)
      ) {
        failures.push(
          `"${name}" (unverändert; angefragt: ${formatValueForError(requestedValue)}, ` +
            `tatsächlich: ${formatValueForError(afterValue)})`,
        );
        continue;
      }

      // Wenn er sich zwar geändert hat, aber NICHT auf den
      // angefragten Wert → auch Fehlschlag.
      if (!valuesMatch(requestedValue, afterValue)) {
        failures.push(
          `"${name}" (verfehltes Ziel; angefragt: ${formatValueForError(requestedValue)}, ` +
            `nach Update: ${formatValueForError(afterValue)})`,
        );
      }
    }
    return failures;
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
    // v0.1.244 — Filter-Auto-Repair. LLMs schicken den Notion-Filter
    // oft in falscher Form: Property-Typ-Wrapper passt nicht zum
    // tatsächlichen Schema (z. B. `{property: "Name", title: ...}`
    // obwohl "Name" ein `rich_text`-Feld ist), oder die Property-
    // Namen-Casing weicht ab. Notion antwortet dann mit 400 +
    // validation_error, der Agent retried 3× identisch und der
    // Anti-Loop-Guard schiesst ihn ab. Wir lesen das Schema vorab
    // und korrigieren die häufigsten Misformate, bevor wir den
    // Call abschicken.
    const originalFilter = opts?.filter;
    let normalisedFilter: unknown = originalFilter ?? undefined;
    let schemaForError: NotionDatabase | null = null;
    if (normalisedFilter) {
      try {
        const db = await this.request<NotionDatabase>(
          `/v1/databases/${encodeURIComponent(databaseId)}`,
        );
        schemaForError = db;
        normalisedFilter = repairNotionFilter(normalisedFilter, db.properties);
      } catch (err) {
        // Schema-Read fehlgeschlagen → wir lassen den Filter durch,
        // Notion antwortet ggf. mit 400. Sieht der Agent dann.
        console.warn(
          "[notion-adapter] filter pre-flight schema read failed:",
          err instanceof Error ? err.message : err,
        );
      }
    }
    // v0.1.246 — Empty-Object-Filter (`{}`) auslassen. Das ist Notion-
    // ungültig (er erwartet entweder einen Property-Filter ODER `and`/
    // `or`), aber semantisch eindeutig "kein Filter". Vorher landete
    // das Empty-Object im Request-Body und Notion antwortete mit
    // verwirrendem 400.
    if (
      normalisedFilter &&
      typeof normalisedFilter === "object" &&
      !Array.isArray(normalisedFilter) &&
      Object.keys(normalisedFilter as Record<string, unknown>).length === 0
    ) {
      console.info(
        "[notion-adapter] queryDatabase: dropping empty {} filter",
      );
      normalisedFilter = undefined;
    }
    // v0.1.246 — Diagnostisches Log: was hat der Agent original geschickt,
    // was haben wir daraus gemacht. Auf stderr, damit der User es im
    // Main-Process-Log sieht falls eine spätere Anfrage trotzdem 400 wirft.
    if (originalFilter !== undefined) {
      console.info(
        `[notion-adapter] queryDatabase filter: original=${JSON.stringify(originalFilter).slice(0, 400)} | repaired=${JSON.stringify(normalisedFilter ?? null).slice(0, 400)}`,
      );
    }
    if (normalisedFilter) body.filter = normalisedFilter;
    if (opts?.sorts) body.sorts = opts.sorts;
    try {
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
    } catch (err) {
      // v0.1.244 — Wenn Notion immer noch 400 antwortet, hängen wir
      // die Schema-Übersicht an die Fehler-Meldung dran. Sonst sieht
      // der Agent nur „Notion API 400: validation_error" und kann nicht
      // self-healen, weil er die Property-Typen nicht kennt.
      if (err instanceof NotionApiError && err.status === 400) {
        // v0.1.246 — Schema-Hint + Filter-Diagnose AN DEN ANFANG, damit
        // sie auch bei truncation der Error-Message sichtbar bleiben.
        // Vorher kam alles ans Ende und wurde von der 200-Byte-Truncation
        // weggeschnitten — der Agent sah nur Notions verwirrenden
        // "or should be defined / and should be defined"-Body.
        let schemaHint = "";
        if (schemaForError) {
          const properties = Object.values(schemaForError.properties).map(
            (p) => `${p.name} (${p.type})`,
          );
          schemaHint =
            `Verfügbare Properties: ${properties.join(", ")}. ` +
            `Beispiel-Filter für Title-Match: ` +
            `{"property":"<title-prop>","title":{"contains":"<wert>"}}. ` +
            `Für rich_text/select/status den passenden Wrapper. `;
        }
        const sentFilterStr = JSON.stringify(
          normalisedFilter ?? null,
        ).slice(0, 300);
        const originalFilterStr = JSON.stringify(originalFilter ?? null).slice(
          0,
          300,
        );
        console.warn(
          `[notion-adapter] queryDatabase 400 ` +
            `original=${originalFilterStr} ` +
            `repaired=${sentFilterStr} ` +
            `body=${err.body.slice(0, 500)}`,
        );
        throw new NotionApiError(
          err.status,
          `${schemaHint}Gesendeter Filter: ${sentFilterStr}. ` +
            `Notion-Originalfehler: ${err.body}`,
        );
      }
      throw err;
    }
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
  ): Promise<{
    propsForApi: Record<string, unknown>;
    warnings: string[];
  }> {
    // Bei Patches müssen wir das DB-Schema des Parents kennen.
    const page = await this.request<NotionPage>(
      `/v1/pages/${encodeURIComponent(pageId)}`,
    );
    if (page.parent.type !== "database_id" || !page.parent.database_id) {
      // Page-im-Page-Hierarchie: nur Title-Patch wird unterstützt.
      const title = properties["title"];
      if (typeof title === "string") {
        return {
          propsForApi: {
            title: {
              title: [{ type: "text", text: { content: title } }],
            },
          },
          warnings: [],
        };
      }
      return { propsForApi: {}, warnings: [] };
    }
    const db = await this.request<NotionDatabase>(
      `/v1/databases/${encodeURIComponent(page.parent.database_id)}`,
    );

    // v0.1.231 — Detailliertes Mapping mit Warnungen statt stillem
    // Skip von unbekannten Property-Namen. Wir validieren auch
    // Select/Status/Multi-Select Options gegen das Schema und warnen,
    // wenn der angefragte Optionsname nicht existiert (Notion würde
    // den Call sonst still no-opten).
    //
    // v0.1.245 — Property-Namen werden via resolvePropertyName fuzzy
    // gematcht: LLMs schicken "Follow-Up" obwohl die Property
    // "Follow-Up (Datum)" heisst; der Verify-After-Step erkennt
    // sonst false negatives, weil convertPropertiesForPatch das
    // Update silently dropped.
    const warnings: string[] = [];
    const knownNames = Object.keys(db.properties);
    const propsForApi: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(properties)) {
      const matched = resolvePropertyName(name, db.properties);
      const def = matched ? db.properties[matched] : undefined;
      if (!matched || !def) {
        warnings.push(
          `Property "${name}" nicht im DB-Schema (existierende: ${knownNames.join(", ")})`,
        );
        continue;
      }
      if (matched !== name) {
        warnings.push(
          `Property "${name}" → "${matched}" (fuzzy-gematcht; bitte zukünftig den exakten Schema-Namen verwenden)`,
        );
      }
      // Option-Validation für Select/Status/Multi-Select.
      const optionCheck = checkOptionMatch(value, def);
      if (optionCheck) warnings.push(optionCheck);

      propsForApi[matched] = valueToApi(value, def);
    }
    return { propsForApi, warnings };
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
  // v0.1.246 — Truncation auf 1500 Zeichen erhöht. Notions
  // validation_error-Bodies sind mehrzeilig (alle möglichen Discriminator-
  // Alternativen werden aufgelistet); plus unser Schema-Hint mit der
  // Property-Liste passt nicht in 200 Zeichen. Wenn der Hint nicht im
  // sichtbaren Text steht, kann der Agent nicht self-healen.
  constructor(public status: number, public body: string) {
    super(`Notion API ${status}: ${body.slice(0, 1500)}`);
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

// ---- v0.1.231 — Verify-After Helpers ---------------------------------------

/**
 * Check ob ein angefragter Select/Status/Multi-Select-Wert in den
 * schema-bekannten Optionen vorhanden ist. Returns null wenn OK, sonst
 * eine Warning-Message für den Caller.
 */
function checkOptionMatch(
  value: unknown,
  def: NotionPropertyDef,
): string | null {
  if (def.type === "select") {
    const options = def.select?.options.map((o) => o.name) ?? [];
    if (options.length === 0) return null;
    const v = typeof value === "string" ? value : null;
    if (v && !options.includes(v)) {
      return `Select "${def.name}": Option "${v}" existiert nicht im Schema (verfügbar: ${options.join(", ")})`;
    }
  } else if (def.type === "status") {
    const options = def.status?.options.map((o) => o.name) ?? [];
    if (options.length === 0) return null;
    const v = typeof value === "string" ? value : null;
    if (v && !options.includes(v)) {
      return `Status "${def.name}": Option "${v}" existiert nicht im Schema (verfügbar: ${options.join(", ")})`;
    }
  } else if (def.type === "multi_select") {
    const options = def.multi_select?.options.map((o) => o.name) ?? [];
    if (options.length === 0) return null;
    const arr = Array.isArray(value) ? value : [value];
    const missing = arr.filter(
      (v) => typeof v === "string" && !options.includes(v),
    );
    if (missing.length > 0) {
      return `Multi-Select "${def.name}": Options ${missing.map((m) => `"${m}"`).join(", ")} existieren nicht im Schema (verfügbar: ${options.join(", ")})`;
    }
  }
  return null;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a === "object") {
    if (Array.isArray(a)) {
      if (!Array.isArray(b) || a.length !== b.length) return false;
      return a.every((x, i) => deepEqual(x, b[i]));
    }
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const ka = Object.keys(ao).sort();
    const kb = Object.keys(bo).sort();
    if (ka.length !== kb.length) return false;
    if (!ka.every((k, i) => k === kb[i])) return false;
    return ka.every((k) => deepEqual(ao[k], bo[k]));
  }
  return false;
}

/**
 * Toleranter Vergleich angefragter vs. tatsächlicher Property-Werte.
 * Notion normalisiert Strings teilweise (Whitespace, Case bei Status-
 * Options); für Daten reicht uns der ISO-Datum-Prefix-Match.
 */
function valuesMatch(requested: unknown, actual: unknown): boolean {
  if (requested === actual) return true;
  if (requested == null || actual == null) return requested === actual;

  if (typeof requested === "string" && typeof actual === "string") {
    return requested.trim().toLowerCase() === actual.trim().toLowerCase();
  }
  if (typeof requested === "boolean" && typeof actual === "boolean") {
    return requested === actual;
  }
  if (typeof requested === "number" && typeof actual === "number") {
    return Math.abs(requested - actual) < 1e-9;
  }
  // Array-Vergleich für multi_select.
  if (Array.isArray(requested) && Array.isArray(actual)) {
    if (requested.length !== actual.length) return false;
    const req = [...requested]
      .map((v) => String(v).trim().toLowerCase())
      .sort();
    const act = [...actual]
      .map((v) => String(v).trim().toLowerCase())
      .sort();
    return req.every((v, i) => v === act[i]);
  }
  // Date: angefragt z. B. "2026-07-16", tatsächlich "2026-07-16" oder
  // `{start: "2026-07-16"}` (kommt aus simplifyPropertyValue für
  // range-Daten als String, bei start-only als String).
  if (typeof requested === "string" && /^\d{4}-\d{2}-\d{2}/.test(requested)) {
    if (typeof actual === "string")
      return actual.startsWith(requested.slice(0, 10));
    if (
      actual &&
      typeof actual === "object" &&
      "start" in actual &&
      typeof (actual as { start: unknown }).start === "string"
    ) {
      return (actual as { start: string }).start.startsWith(
        requested.slice(0, 10),
      );
    }
  }
  return deepEqual(requested, actual);
}

function formatValueForError(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "string") return `"${v}"`;
  if (Array.isArray(v)) return `[${v.map(formatValueForError).join(", ")}]`;
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

// ---- v0.1.244 — Notion-Filter Auto-Repair -----------------------------------
//
// LLMs schicken den Filter regelmäßig in falscher Form:
//   - Property-Typ-Wrapper passt nicht zum echten DB-Schema
//     (z. B. {property:"Name", title:{contains:"X"}} obwohl "Name"
//     ein rich_text-Feld ist — Notion antwortet mit 400 +
//     validation_error.)
//   - Property-Namen-Casing weicht ab ("status" vs "Status").
//   - Alte Form ohne `property`-Key: {Name:{equals:"X"}}.
//
// Wir korrigieren die häufigsten Misformate, bevor wir den Call
// schicken. Was wir nicht sicher reparieren können, lassen wir
// durch — Notion antwortet dann mit 400 und unser Error-Wrapper
// hängt das Schema dran, damit der Agent self-healen kann.
const KNOWN_NOTION_TYPES: ReadonlySet<string> = new Set([
  "title",
  "rich_text",
  "select",
  "multi_select",
  "status",
  "date",
  "number",
  "checkbox",
  "url",
  "email",
  "phone_number",
  "people",
  "files",
  "formula",
  "relation",
  "rollup",
]);

function repairNotionFilter(
  filter: unknown,
  schema: Record<string, NotionPropertyDef>,
): unknown {
  if (filter === null || typeof filter !== "object") return filter;
  // Composite-Wrapper unverändert tiefer rekursieren.
  const obj = filter as Record<string, unknown>;
  if (Array.isArray(obj.and) || Array.isArray(obj.or)) {
    const key = Array.isArray(obj.and) ? "and" : "or";
    const arr = obj[key] as unknown[];
    return {
      ...obj,
      [key]: arr.map((f) => repairNotionFilter(f, schema)),
    };
  }
  // Variante (a): Agent schickt `{Name: {equals: "X"}}` ohne
  // `property`-Wrapper. Notion verlangt {property, <type>:...}.
  // Wir versuchen das umzubauen, wenn EIN Key ein bekannter
  // Property-Name ist.
  if (typeof obj.property !== "string") {
    const keys = Object.keys(obj);
    if (keys.length === 1) {
      const k = keys[0]!;
      // Variante (a1): key ist ein Property-Name → wrap as
      // {property: name, ...inner}
      const matched = resolvePropertyName(k, schema);
      if (matched) {
        const inner = obj[k] as Record<string, unknown> | undefined;
        if (inner && typeof inner === "object") {
          return repairNotionFilter(
            { property: matched, ...inner },
            schema,
          );
        }
      }
      // Variante (a2): key ist ein Type-Name (z. B. "title", "rich_text")
      // ohne dass es eine Property mit diesem Namen gibt. Der häufigste
      // LLM-Fehler bei Title-Filter: `{title: {contains: "X"}}`.
      // Wir finden die Property dieses Typs im Schema und wrappen damit.
      if (KNOWN_NOTION_TYPES.has(k)) {
        const propsOfType = Object.values(schema).filter(
          (d) => d.type === k,
        );
        if (propsOfType.length === 1) {
          const propName = propsOfType[0]!.name;
          const innerValue = obj[k];
          console.info(
            `[notion-adapter] repairFilter: top-level type "${k}" -> wrapped with property "${propName}"`,
          );
          return { property: propName, [k]: innerValue };
        }
        if (propsOfType.length > 1) {
          // Mehrere Properties des gleichen Typs (z. B. zwei
          // rich_text-Felder). Wir können nicht raten welches
          // gemeint ist — der Notion-400 hilft dem Agent mehr als
          // ein falscher Wrap.
          console.info(
            `[notion-adapter] repairFilter: ambiguous top-level type "${k}" (${propsOfType.length} candidates), leaving as is`,
          );
        }
      }
    }
    // Letzte Rettung: nur Operator-Keys (`{contains: "X"}`,
    // `{equals: "X"}`). Wenn das Schema eine eindeutige Title-
    // Property hat, defaulten wir auf Title-Contains.
    const operatorKeys = new Set([
      "equals",
      "does_not_equal",
      "contains",
      "does_not_contain",
      "starts_with",
      "ends_with",
      "is_empty",
      "is_not_empty",
    ]);
    const objKeys = Object.keys(obj);
    if (objKeys.length > 0 && objKeys.every((k) => operatorKeys.has(k))) {
      const titleProp = Object.values(schema).find((d) => d.type === "title");
      if (titleProp) {
        console.info(
          `[notion-adapter] repairFilter: bare operators wrapped as title-filter on "${titleProp.name}"`,
        );
        return { property: titleProp.name, title: { ...obj } };
      }
    }
    return filter;
  }
  // Variante (b): Property gibts, aber Casing weicht ab → auf
  // den echten Schema-Namen mappen.
  const matched = resolvePropertyName(obj.property as string, schema);
  if (!matched) {
    // Property gibt's nicht im Schema → unverändert lassen, Notion
    // antwortet mit klarem 400.
    return filter;
  }
  const def = schema[matched]!;
  const fixed: Record<string, unknown> = {
    ...obj,
    property: matched,
  };
  // Variante (c): Typ-Wrapper passt nicht zum echten Schema-Typ.
  // Beispiel: {property:"Name", title:{...}} aber "Name" ist
  // rich_text → wir mappen das nach {property:"Name", rich_text:{...}}.
  const expectedWrapper = def.type;
  let foundWrapper: string | null = null;
  for (const w of KNOWN_NOTION_TYPES) {
    if (w in fixed && w !== "property") {
      foundWrapper = w;
      break;
    }
  }
  if (foundWrapper && foundWrapper !== expectedWrapper) {
    const innerValue = fixed[foundWrapper];
    delete fixed[foundWrapper];
    fixed[expectedWrapper] = innerValue;
    console.info(
      `[notion-adapter] repairFilter: ${matched} wrapper "${foundWrapper}" -> "${expectedWrapper}"`,
    );
  }
  return fixed;
}

// v0.1.245 — Fuzzy property-name resolution. LLMs senden gerne
// "Follow-Up" obwohl die Property eigentlich "Follow-Up (Datum)"
// heisst. Wir matchen tolerant:
//   1. exakter Match
//   2. case-insensitiv
//   3. ignore Klammer-Suffixe ("X (Y)" matched "X")
//   4. ignore Sonderzeichen + Whitespace
//   5. Prefix-Match (one direction)
// Erster Treffer gewinnt. Gleichstand → null statt zu raten.
export function resolvePropertyName(
  candidate: string,
  schema: Record<string, NotionPropertyDef>,
): string | null {
  if (candidate in schema) return candidate;
  const names = Object.keys(schema);
  const cLower = candidate.toLowerCase();
  // case-insensitiv exakt
  for (const n of names) {
    if (n.toLowerCase() === cLower) return n;
  }
  const normalize = (s: string) =>
    s
      .toLowerCase()
      .replace(/\([^)]*\)/g, "") // Klammer-Suffixe weg
      .replace(/[^a-z0-9äöüß]/gi, "") // Sonderzeichen + Whitespace
      .trim();
  const cNorm = normalize(candidate);
  if (!cNorm) return null;
  // exakter normalisierter Match (ignore parens + special chars)
  for (const n of names) {
    if (normalize(n) === cNorm) return n;
  }
  // Prefix-Match: Schema "Follow-Up (Datum)" vs Agent-Input "Follow-Up"
  const prefixMatches = names.filter((n) => normalize(n).startsWith(cNorm));
  if (prefixMatches.length === 1) return prefixMatches[0]!;
  // Reverse Prefix-Match: Agent-Input "Follow-Up Datum" vs Schema "Follow-Up"
  const reverseMatches = names.filter((n) => cNorm.startsWith(normalize(n)));
  if (reverseMatches.length === 1) return reverseMatches[0]!;
  return null;
}
