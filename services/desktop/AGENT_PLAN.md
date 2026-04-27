# Phase 8 — Agentic layer

The local research agent. First-tab landing surface; controls the app via
tools; talks to the gateway and (later) to remote model providers.

## Substeps

| ID  | Title                                                                          | Status |
|-----|--------------------------------------------------------------------------------|--------|
| 8.a | Orchestrator + Ollama tool-calling client + IPC scaffolding                    | done   |
| 8.b | Read tools (company / transaction / evaluation gateway proxies)                | done   |
| 8.c | UI tools (`askUser`, `navigate`, `notify`) + Chat UI + ChoiceCard              | done   |
| 8.j | **Self-service provider switch** (Ollama ↔ OpenAI, key storage, settings tools)| done   |
| 8.h | Gateway `POST /v1/companies` single-row ingest endpoint                        | done   |
| 8.d | Markdown memory + writable-userData probe + FirstRunWizard fallback            | done   |
| 8.e | Write tools (importExcel, retryStage, evaluation creates) + Idempotency-Key    |        |
| 8.f | Watchers + News route + native notifications + DND / quiet hours               |        |
| 8.g | Settings → Agent panel (toggle, model, memory dir, notifications, allow-list) |        |
| 8.i | DESKTOP_DATA_FLOW.md §13 + DECISIONS.md agent entries                          |        |

## 8.j — Self-service provider switch (NEW)

Goal: a user can say *"switch me to OpenAI, here's my key"* in the chat and
the agent reconfigures itself end-to-end. Reverse direction works the same way.

### Scope

**In scope (desktop-local):**

- Provider abstraction in `src/main/agent/`. Today `streamChat()` lives in
  `ollama-client.ts` and is called directly by the orchestrator. Refactor to:
  ```ts
  interface LlmProvider {
    id: "ollama" | "openai";
    streamChat(req: ProviderChatRequest): AsyncGenerator<ChatStreamFrame>;
    isReady(): boolean;
    describe(): { model: string | null; reason?: string };
  }
  ```
  Implementations: `OllamaProvider` (wraps current code), `OpenAiProvider`
  (calls `https://api.openai.com/v1/chat/completions` with `tools`).
- Provider config store at `app.getPath("userData")/agent/provider.json`:
  ```json
  { "provider": "ollama", "openai": { "model": "gpt-4.1-mini", "embedModel": "text-embedding-3-small" } }
  ```
  Watched by the orchestrator; reload swaps the active provider without app restart.
- API-key storage via Electron `safeStorage.encryptString` →
  `app.getPath("userData")/agent/openai.enc`. Same pattern as auth.ts's
  refresh-token persistence. Never logged. Never sent to the renderer.
- Settings tools (registered alongside read tools), so the chat agent can
  drive the switch itself:
  - `settings_get_provider()` — returns current provider, model name, and
    `hasOpenAiKey: boolean` (never the key itself).
  - `settings_set_provider({ provider, openaiApiKey?, model?, embedModel? })`
    — atomic switch. Refuses `provider="openai"` if no key is stored AND
    none is supplied. Validates the key with a one-shot `GET /v1/models`
    call before persisting.
  - `settings_clear_openai_key()` — wipes the encrypted key file and
    forces a fall-back to Ollama if it was active.

**Out of scope (deferred to a follow-up):**

- *Pipeline-wide* provider switch (cascade in master-data + embeddings in
  evaluation also using OpenAI). That requires gateway endpoints and
  per-service config plumbing. Track as `8.j2 — pipeline provider switch`
  once the desktop side ships.
- Anthropic / Azure-OpenAI / other vendors. Add adapters when there's a
  user request — `LlmProvider` is the seam.

### Acceptance

- From a fresh install with Ollama running:
  1. User: *"Switch to OpenAI, key=sk-..."* → agent calls
     `settings_set_provider`, key validates, config writes, next assistant
     turn streams from OpenAI.
  2. User: *"Go back to local"* → agent calls
     `settings_set_provider({provider:"ollama"})`, next turn streams from
     Ollama.
- Settings → Agent panel (8.g) shows the same controls; the panel and the
  chat tools share `settings_set_provider` under the hood.
- Restart preserves choice. Nuking `userData/agent/openai.enc` falls back
  to Ollama with a single status-line warning.

### Touch points

- **`src/main/agent/providers/`** — new dir, `ollama-provider.ts`,
  `openai-provider.ts`, `index.ts` exporting `selectProvider(config)`.
- **`src/main/agent/orchestrator.ts`** — `streamChat` import becomes
  `provider.streamChat`; `getStatus()` reads from the active provider.
- **`src/main/agent/settings.ts`** — config + key storage.
- **`src/main/agent/tools/settings.ts`** — three tools above.
- **`shared/types.ts`** — `AgentProvider = "ollama" | "openai"` and
  `AgentStatus.provider` field.
