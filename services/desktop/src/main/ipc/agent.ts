// IPC-Handler „Chat-Agent, Gedächtnis, Anhänge, Vollmacht“, aus src/main/index.ts herausgelöst (docs/PLAN_AVA_CLOUD.md §12, R2).
// Die Handler sind unverändert; die Abhängigkeiten kommen explizit über `deps`.
// Spät gesetzte Dienste (vormals `let` in index.ts) werden als Getter übergeben.

import { BrowserWindow, app, ipcMain, protocol, session } from "electron";
import { LlmProviderManager, MemoryStore } from "../agent";
import { join } from "node:path";
import type { AgentChoiceAnswer, AgentSendInput, HostedProviderKind } from "../../shared/types";
import type { AgentOrchestrator, AttachmentStore, AutonomyStore, GeneralMemoryStore, LlmProviderKind, ProviderConfig, StagedSheetSummary } from "../agent";
import type { ProviderConfigStore } from "../agent/providers/store";
import type { AuditEventInput } from "../audit/audit-types";
import type { Auth } from "../auth";

export interface AgentIpcDeps {
  agent: AgentOrchestrator;
  attachments: AttachmentStore;
  audit: (input: AuditEventInput) => void;
  auth: Auth;
  autonomyStore: AutonomyStore;
  generalMemory: GeneralMemoryStore;
  memory: MemoryStore;
  memoryProbe: ReturnType<MemoryStore["probe"]>;
  providerConfigStore: ProviderConfigStore;
  providers: LlmProviderManager;
}

export function registerAgentIpc(deps: AgentIpcDeps): void {
  const { agent, attachments, audit, auth, autonomyStore, generalMemory, memory, memoryProbe, providerConfigStore, providers } = deps;

  // Agent IPC. Stream frames arrive via `agent:stream`; the renderer is
  // expected to filter by `requestId` (the protocol leaves room for future
  // parallel requests, but 8.a only allows one in-flight at a time).
  ipcMain.handle("agent:getStatus", () => agent.getStatus());

  // v0.1.468 — Autonomie-Modus (global, Claude-Code-Muster).
  ipcMain.handle("agent:getAutonomyMode", () => autonomyStore.getMode());

  ipcMain.handle(
    "agent:setAutonomyMode",
    (_e, mode: "manual" | "additive" | "mutating") => {
      const next = autonomyStore.setMode(mode);
      audit({
        actorType: "user",
        actorId: null,
        category: "agent",
        action: "agent.autonomy.mode",
        severity: "info",
        subjectType: null,
        subjectId: null,
        summary: `Autonomie-Modus: ${
          next === "manual"
            ? "Manuell"
            : next === "additive"
              ? "Halb-auto"
              : "Voll-auto (außer Löschen)"
        }`,
        metadata: { mode: next },
      });
      return next;
    },
  );

  ipcMain.handle("agent:send", (_e, input: AgentSendInput) => agent.send(input));

  ipcMain.handle("agent:abort", (_e, requestId?: string) => {
    agent.abort(requestId);
  });

  ipcMain.handle("agent:answerChoice", (_e, answer: AgentChoiceAnswer) => {
    agent.answerChoice(answer.choiceId, answer.value);
  });

  // Provider switch IPC (Phase 8.j). Mirrors the settings_* tools so the
  // forthcoming Settings → Agent panel (8.g) can drive the same surface.
  ipcMain.handle("agent:getProviderConfig", () => providers.getConfigBundle());

  // Option D — BYO-key passthrough. The renderer's `gatewayUpload`
  // (Excel ingest) attaches these headers on dispatch. Returns null
  // when no provider is configured / Ollama is active / key missing,
  // and the producer falls back to its env-baked LLM. Keeps the
  // plaintext key off-disk (decrypted on demand each call).
  ipcMain.handle(
    "agent:getActiveUserLlm",
    () => providers.getActiveUserLlm(),
  );

  // Catalog projection (Phase 8.k2). Always LLM + tool-capable models —
  // see LlmProviderManager.listModels() for the rationale.
  ipcMain.handle("agent:listModels", () => providers.listModels());

  ipcMain.handle(
    "agent:setProvider",
    (_e, args: { kind: LlmProviderKind; model?: string }): ProviderConfig =>
      providers.setProvider(args.kind, { model: args.model }),
  );

  ipcMain.handle(
    "agent:setModel",
    (_e, args: { kind: LlmProviderKind; model: string }): ProviderConfig =>
      providers.setModel(args.kind, args.model),
  );

  ipcMain.handle(
    "agent:setProducerModel",
    (_e, args: { kind: LlmProviderKind; model: string }) =>
      providers.setProducerModel(args.kind, args.model),
  );

  // O5 — Schluesselquelle je Anbieter (eigen | organisation).
  ipcMain.handle(
    "agent:setKeySource",
    (_e, args: { kind: LlmProviderKind; source: "eigen" | "organisation" }): ProviderConfig =>
      providers.setKeySource(args.kind, args.source),
  );

  ipcMain.handle(
    "agent:setApiKey",
    async (_e, args: { kind: HostedProviderKind; apiKey: string }) => {
      // v0.1.216 — Anthropic-API-Key-Pfad eingestellt. UI versteckt
      // den Input bereits (Settings/FirstRunWizard); wir blockieren
      // hier zusätzlich, damit weder ein stale Renderer noch ein
      // direkter ipcRenderer.invoke vorbeikommt. Manager wirft
      // ebenfalls als letzter Layer.
      if (args.kind === "anthropic") {
        throw new Error(
          "Anthropic-API-Key-Anmeldung wird nicht mehr unterstützt. " +
            "Bitte über das Pro/Max-Abo anmelden (Einstellungen → " +
            "Modelle → Anthropic).",
        );
      }
      await providers.setApiKey(args.kind, args.apiKey);
    },
  );

  // Phase 8.k10b — cheap probe ("is this key valid") used by the
  // skip-to-external flow before we persist + flip provider. Does not
  // mutate state on its own.
  ipcMain.handle(
    "agent:validateApiKey",
    (_e, args: { kind: HostedProviderKind; apiKey: string }) =>
      providers.validateApiKey(args.kind, args.apiKey),
  );

  ipcMain.handle(
    "agent:clearApiKey",
    (_e, args: { kind: HostedProviderKind }) => {
      providers.clearApiKey(args.kind);
    },
  );

  ipcMain.handle("agent:clearOpenAISubscriptionToken", () => {
    providers.clearOpenAISubscriptionToken();
    return { ok: true };
  });

  // docs/PLAN_SIGN_IN_WITH_CHATGPT.md — offizieller „Sign in with ChatGPT“-
  // Flow mit Plan-Nutzung. Konten sind persoenlich; die Installations-ID
  // liegt je Geraet, die Verbindung je Account (verschluesselt).
  ipcMain.handle(
    "agent:connectChatgptPlan",
    async (event): Promise<{ ok: true; email: string | null; planScope: boolean } | { ok: false; error: string }> => {
      // Die Anbieter-Sperre hindert nicht, wenn die Organisation das
      // persoenliche Abo ausdruecklich freigibt (Standard an).
      if (!providers.chatgptPlanErlaubt()) {
        return { ok: false, error: "Organisationsvorgabe: Das persönliche ChatGPT-Abo ist in dieser Organisation nicht erlaubt." };
      }
      try {
        const parent =
          BrowserWindow.fromWebContents(event.sender) ??
          BrowserWindow.getFocusedWindow() ??
          BrowserWindow.getAllWindows()[0] ??
          null;
        const { ladeOderErzeugeHostId } = await import("../auth/siwc-oauth");
        const { runSiwcOAuth } = await import("../auth/siwc-oauth-flow");
        const hostId = ladeOderErzeugeHostId(join(app.getPath("userData"), "siwc-host.json"));
        const { vorherigePlanHuelle, siwcErgebnisUebernehmen } = await import("../auth/siwc-anwenden");
        const vorherige = await vorherigePlanHuelle(providerConfigStore);
        const ergebnis = await runSiwcOAuth({
          hostId,
          clientId: vorherige?.clientId ?? null,
          idTokenHint: vorherige?.idToken ?? null,
          loginHint: vorherige?.email ?? null,
          parent,
        });
        return await siwcErgebnisUebernehmen(providers, ergebnis, vorherige);
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  ipcMain.handle("agent:chatgptPlanStand", () => providers.chatgptPlanStand());

  // docs/PLAN_CHATGPT_ABO_UEBERALL.md: Firmenverarbeitung ueber das Abo an/aus.
  ipcMain.handle("agent:setChatgptPlanProducer", async (_e, an: boolean) => {
    providers.setChatgptPlanProducer(Boolean(an));
    return { ok: true as const, stand: await providers.chatgptPlanStand() };
  });

  ipcMain.handle("agent:ladeChatgptPlanModelle", async () => {
    try {
      return { ok: true as const, stand: await providers.ladeChatgptPlanModelle() };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("agent:setChatgptPlanModell", async (_e, modell: string | null) => {
    try {
      return { ok: true as const, stand: await providers.setChatgptPlanModell(modell) };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Memory IPC (Phase 8.d). The probe is cached on the MemoryStore — these
  // handlers are read-only views; mutations happen implicitly as the
  // orchestrator appends messages.
  ipcMain.handle("agent:getMemoryProbe", () => memoryProbe);

  ipcMain.handle("agent:listConversations", () => memory.list());

  // Phase 8.k10h — load a specific conversation's transcript so the
  // renderer can replay it on session-switch. Returns [] for unknown
  // ids / parse failures (consistent with MemoryStore.load semantics).
  // v0.1.151 — still-open choice/text prompts for a conversation.
  // The renderer calls this on mount / conversation switch to re-paint
  // any prompt cards whose original stream frame was missed (Chat
  // wasn't mounted, or the user navigated away mid-prompt).
  ipcMain.handle("agent:getPendingPrompts", (_e, conversationId: string) =>
    agent.getPendingPrompts(conversationId),
  );

  ipcMain.handle("agent:loadConversation", (_e, conversationId: string) =>
    memory.load(conversationId),
  );

  ipcMain.handle("agent:deleteConversation", (_e, conversationId: string) =>
    memory.delete(conversationId),
  );

  // v0.1.85 — full-text search across every conversation file. Boring
  // case-insensitive AND across whitespace-split terms, capped at
  // limit/perChat. User + assistant only.
  ipcMain.handle(
    "agent:searchConversations",
    (_e, args: { query: string; limit?: number; perChat?: number }) =>
      memory.search(args.query, { limit: args.limit, perChat: args.perChat }),
  );

  // General memory IPC (Phase 8.k10h). The agent reads/writes via the
  // `recall_memory` / `remember` tools; these handlers exist so a future
  // Settings → Memory panel can surface entries to the user for review
  // and manual deletion.
  ipcMain.handle("agent:listGeneralMemory", () => generalMemory.list());

  ipcMain.handle(
    "agent:addGeneralMemory",
    (_e, args: { content: string; tags?: string[] }) =>
      generalMemory.add(args),
  );

  ipcMain.handle("agent:removeGeneralMemory", (_e, id: string) =>
    generalMemory.remove(id),
  );

  // Attachment staging (Phase 8.e). The renderer parses the spreadsheet
  // for the chip preview, then ships the raw bytes here on send so the
  // `import_excel` tool can re-upload them to the gateway. We hold them
  // in-process (TTL'd) keyed by a UUID that's woven into the user
  // prompt — bytes never enter the LLM context.
  ipcMain.handle(
    "agent:stageAttachment",
    (
      _e,
      input: {
        filename: string;
        bytes: Uint8Array;
        sheets: StagedSheetSummary[];
        conversationId?: string;
        seiten?: string[];
      },
    ) => {
      // Electron's structured-clone IPC may deliver the bytes as a Node
      // Buffer or a Uint8Array view backed by a different ArrayBuffer.
      // Normalise once so the store always holds a plain Uint8Array.
      const u8 =
        input.bytes instanceof Uint8Array
          ? new Uint8Array(input.bytes)
          : new Uint8Array(input.bytes as ArrayBufferLike);
      const entry = attachments.stage({
        filename: input.filename,
        bytes: u8,
        sheets: input.sheets,
        ...(input.conversationId ? { conversationId: input.conversationId } : {}),
        ...(input.seiten ? { seiten: input.seiten } : {}),
      });
      return {
        id: entry.id,
        filename: entry.filename,
        sizeBytes: entry.sizeBytes,
      };
    },
  );

  ipcMain.handle("agent:discardAttachment", (_e, id: string) =>
    attachments.discard(id),
  );

  // v0.1.301 — PDF-Text-Extraction über pdf-parse (existiert schon als
  // dep, wird auch im Mail-Pfad genutzt). Renderer kann pdf-parse nicht
  // direkt nutzen (Node-Bindings), deshalb dieser IPC-Roundtrip.
  // Returnt extrahierten Text + Seitenzahl + Filename für den Chip.
  ipcMain.handle(
    "agent:extractPdfText",
    async (
      _e,
      input: { filename: string; bytes: Uint8Array },
    ): Promise<{
      text: string;
      numPages: number;
      filename: string;
      truncated: boolean;
      /** 2026-09-30: Text je Seite fuer datei_lesen/datei_suchen. */
      seiten: string[];
    }> => {
      const u8 =
        input.bytes instanceof Uint8Array
          ? new Uint8Array(input.bytes)
          : new Uint8Array(input.bytes as ArrayBufferLike);
      const buf = Buffer.from(u8);
      // DOCX ueber mammoth (liegt als Abhaengigkeit vor): eine "Seite".
      if (input.filename.toLowerCase().endsWith(".docx")) {
        try {
          const mammoth = (await import("mammoth")) as unknown as { extractRawText: (o: { buffer: Buffer }) => Promise<{ value: string }> };
          const text = (await mammoth.extractRawText({ buffer: buf })).value ?? "";
          return { text: text.slice(0, 200_000), numPages: 1, filename: input.filename, truncated: text.length > 200_000, seiten: [text] };
        } catch (err) {
          throw new Error(`DOCX "${input.filename}" konnte nicht gelesen werden: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      // Lazy-import wie im Mail-Attachment-Pfad — pdf-parse hat Top-
      // Level-Side-Effects (öffnet ein Test-PDF), die wir nur lazy
      // tolerieren wollen.
      const mod = (await import("pdf-parse")) as unknown as {
        default: (data: Buffer, opts?: { pagerender?: (p: unknown) => Promise<string> }) => Promise<{ text: string; numpages: number }>;
      };
      try {
        // Seitenweise sammeln (gleiche Logik wie pdf-parse intern, nur
        // dass wir jede Seite einzeln behalten).
        const seiten: string[] = [];
        const pagerender = async (pageData: unknown): Promise<string> => {
          const p = pageData as { getTextContent: (o: { normalizeWhitespace: boolean; disableCombineTextItems: boolean }) => Promise<{ items: Array<{ str: string; transform: number[] }> }> };
          const tc = await p.getTextContent({ normalizeWhitespace: true, disableCombineTextItems: false });
          let text = ""; let lastY: number | null = null;
          for (const item of tc.items) {
            const y = item.transform[5] ?? 0;
            text += lastY === null || lastY === y ? item.str : `\n${item.str}`;
            lastY = y;
          }
          seiten.push(text);
          return text;
        };
        const result = await mod.default(buf, { pagerender });
        const TEXT_CAP = 200_000; // ~50k tokens, hoch genug für Verträge
        const text = result.text ?? "";
        return {
          text: text.slice(0, TEXT_CAP),
          numPages: result.numpages ?? 0,
          filename: input.filename,
          truncated: text.length > TEXT_CAP,
          seiten,
        };
      } catch (err) {
        throw new Error(
          `PDF "${input.filename}" konnte nicht gelesen werden: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  );
}
