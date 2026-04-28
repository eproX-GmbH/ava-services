# Ollama integration — local-first LLM for the desktop app

**Goal:** non-technical customers install AVA Desktop and have a working LLM
out of the box, with no API keys, no separate Ollama install, no model
downloads they have to figure out themselves. OpenAI/Anthropic/Google
providers stay supported as power-user opt-ins.

## Why local-first

- D4 (DECISIONS.md) already picks Ollama as the default; `packages/ai-provider`
  is wired for it (`createOllama`, default LLM `gemma3:4b`, default embedder
  `embeddinggemma`). The plumbing exists — what's missing is the lifecycle.
- Customer base is non-technical. "Get an OpenAI key" is a hard stop.
- Their data (German company filings, contacts, evaluations) is privacy-
  sensitive — running locally avoids cross-border data transfer entirely.
- Cost: zero per-call after the one-time model download.

## Architecture

```
┌─────────────────────── AVA Desktop (Electron) ───────────────────────┐
│                                                                       │
│  main process (electron/main/index.ts)                                │
│   ├── OllamaSupervisor                                                │
│   │     • spawns `ollama serve` (bundled binary)                      │
│   │     • port = userData/ollama.port (random free port, >49152)      │
│   │     • OLLAMA_MODELS = userData/ollama-models                      │
│   │     • health-checks /api/tags every 2s on boot                    │
│   │     • on quit → SIGTERM → wait 5s → SIGKILL                       │
│   │     • exposes status via IPC `ollama:status`                      │
│   ├── ProducerSupervisor (Step 6 follow-up)                           │
│   │     • spawns each producer with                                   │
│   │       LLM_PROVIDER=ollama OLLAMA_URL=http://127.0.0.1:<port>/api │
│   └── GatewaySupervisor                                               │
│                                                                       │
│  renderer                                                             │
│   ├── FirstRunWizard                                                  │
│   │     • on first launch, if ollama-models/ has no models:          │
│   │         pull `gemma3:4b` (~3.3 GB) + `embeddinggemma` (~620 MB)  │
│   │         show progress (bytes streamed via SSE from /api/pull)    │
│   │         block "Continue" until both ready                         │
│   │     • subsequent launches: skip if both models present            │
│   └── Settings → AI Provider                                          │
│         • radio: Local (Ollama) [default] | OpenAI | Anthropic | Google│
│         • per-provider key field (encrypted via electron safeStorage)│
└───────────────────────────────────────────────────────────────────────┘
```

## Dev environment (Phase 1 — implemented)

`scripts/dev.sh` boots an `ollama` container alongside the rest of the
hostlocal stack and pre-pulls the default models on first run. Everything
points at `http://localhost:11434` via `OLLAMA_URL` in `.env.dev`. Toggle
between OpenAI and Ollama by flipping `LLM_PROVIDER`.

Storage: a named docker volume `ollama-models` so models survive container
restarts (saves the ~4 GB re-download).

## Production bundling (Phase 2 — design)

### Binary

Ollama ships a single static binary per platform (~30 MB). Bundle as
electron-builder `extraResources`, **not** asar-packed (asar can't be
exec'd). Path resolution at runtime:

```ts
const binPath = app.isPackaged
  ? path.join(process.resourcesPath, "ollama", platform, exe)
  : path.join(__dirname, "../../resources/ollama", platform, exe);
```

| Platform | Binary                                  | Size |
|----------|-----------------------------------------|------|
| macOS arm64 | `ollama-darwin-arm64`                | ~30 MB |
| macOS x64   | `ollama-darwin-x64`                  | ~30 MB |
| Windows x64 | `ollama-windows-amd64.exe`           | ~50 MB |
| Linux x64   | `ollama-linux-amd64`                 | ~30 MB |

Download in CI from `github.com/ollama/ollama/releases`, verify SHA256,
commit to `services/desktop/resources/ollama/<platform>/`. Or fetch via
`postinstall` script driven by `package.json` (keeps the repo small —
preferred). First-run signing on macOS via the existing notarization step.

### Models — download, don't bundle

3.3 GB per LLM × installer = no. Ship the binary, download models on first
run from the renderer's FirstRunWizard. UX:

1. Welcome screen — "AVA needs to download a 4 GB language model. This is
   a one-time download." Progress bar, est. time at user's measured
   download speed.
2. Stream `/api/pull` (newline-delimited JSON: `{status, completed, total}`),
   forward to renderer via webContents.send.
3. Both models in parallel? No — bandwidth contention; sequential is
   simpler and clearer in the UI.
4. Resumable: ollama's pull is idempotent and resumable by default.
5. Models live in `app.getPath('userData')/ollama-models` so uninstall
   cleans them up (vs. `~/.ollama` which would orphan).

### Lifecycle

`OllamaSupervisor` is owned by main. Producer supervisors must wait for
ollama-ready before they spawn (they call `getLLM()` lazily but the import
chain in `ai-provider/src/index.ts` resolves `process.env.OLLAMA_URL` at
container construction). Gate via a Promise<void> exposed by the
supervisor.

```ts
class OllamaSupervisor {
  readonly ready: Promise<{ baseURL: string }>;
  start(): void;            // spawns process, sets port
  stop(signal?): Promise<void>;
  pull(model: string): AsyncIterable<PullProgress>;
  list(): Promise<Model[]>;
}
```

### Failure modes

- **No models downloaded yet** → first-run wizard handles. If user closes
  the wizard, app stays in "limited mode" (Excel upload disabled, master-
  data exact lookup still works).
- **Ollama crash mid-session** → supervisor restarts up to 3× in 60s, then
  surfaces a banner. Crashes are rare in practice (memory exhaustion is
  the only common cause; we'll cap context window at the model default).
- **Insufficient disk** → pre-flight check: require 8 GB free in userData
  before allowing pull. Show clear error otherwise.
- **No GPU on Windows** → CPU fallback works, just slower (~5× on a
  modern laptop). Don't gate launch on GPU.

### Settings

`app.config.json` in userData persists `{ llmProvider, llmModel }`. The
renderer's Settings → AI Provider page lets advanced users switch to
OpenAI/Anthropic/Google. If they do, their key is stored via
`safeStorage.encryptString()` (Keychain/DPAPI/libsecret-backed); the
ProducerSupervisor passes it via env on next start.

## Two LLM call paths — keep them separate

The current code already has two patterns; this plan formalizes the split.

### Path 1: Generic LLM + Embeddings (user-swappable, defaults to Ollama)

Used for keyword extraction, classification, dedup/refinement,
embeddings, chat — everything that doesn't need OpenAI-specific features.
Goes through `packages/ai-provider/src/index.ts`:

- `getLLM()` reads `LLM_PROVIDER` (`ollama` | `openai` | `anthropic` | `google`)
- `getEmbedder()` reads `EMBED_PROVIDER` (`ollama` | `openai` | `google`)
- Default: **ollama** (after Phase 2 — currently still `openai` for the
  evaluation A/B)

The renderer Settings page (and later the in-app agent) only writes
these vars. "Switch to Anthropic" is a one-call config write.

### Path 2: Deep Research (OpenAI-only, opt-in)

The `website` service's deep-research feature uses OpenAI-specific
capabilities that no other provider has:

- `web_search` / `web_search_preview` tool
- `o4-mini-deep-research-2025-06-26` model
- Responses API with structured output

This is OpenAI-only on purpose, with a separate env var
(`DEEP_RESEARCH_OPENAI_API_KEY`) so it can have its own key/billing
boundary independent of Path 1. Implemented as
`getDeepResearchClient()` in ai-provider — returns `null` if no key is
configured, in which case callers fall back gracefully to the cheap
pipeline (which respects Path 1).

### Migration

1. **Done — env split.** `getDeepResearchClient()` exists in
   `packages/ai-provider`; `.env.dev` has separate `DEEP_RESEARCH_*`
   vars; OLLAMA env wiring in place.
2. **Phase 1 — dev runs ollama.** `infra/docker-compose.dev-hostlocal.yml`
   has the `ollama/ollama` service; `scripts/ollama-bootstrap.sh` pulls
   `gemma3:4b` + `embeddinggemma`; `dev.sh` invokes it.
3. **Refactor company-evaluation** (next). Today it instantiates
   `new OpenAI(...)` directly and calls `chat.completions.create` ~7
   times. None of those calls are deep-research — they're keyword
   extraction, dedup, classification. Each should move to `getLLM()` so
   they pick up the user's chosen provider. The `embeddings.create` call
   should move to `getEmbedder()`.
4. **Refactor website (partial).** Keep `executeDeepResearch` and
   `findJobPostings` fallback paths on the raw OpenAI client (Path 2).
   Move the `extractFindingsBatch` / `refineFindings` calls (already
   using `llm` — that's `getLLM()`) — already done; just verify default
   ollama works for them.
5. **A/B evaluation.** Same Excel uploads, both providers, compare
   evaluation quality on `gemma3:4b` vs `gpt-4o-mini`. If gemma3:4b
   isn't "good enough," try `qwen2.5:7b` or `llama3.1:8b`.
6. **Phase 2 — Electron bundling.** Binary in `extraResources`,
   `OllamaSupervisor` in main, `FirstRunWizard` in renderer. Default
   `LLM_PROVIDER=ollama`.
7. **Phase 3 — Agent self-service.** The in-app AI agent gets a
   `set_llm_provider({ provider, model, apiKey? })` tool that writes
   `app.config.json` (encrypted via `safeStorage` for keys), then asks
   the supervisor to restart producers with new env. User says "switch
   to Claude Sonnet" → the agent flips `LLM_PROVIDER=anthropic` +
   `LLM_MODEL=claude-sonnet-4-6`, prompts for the key, restarts. Deep
   research stays opt-in via a separate "enable deep research" toggle
   that prompts for the OpenAI key only.

## Open questions

- Embedding dimensionality: `embeddinggemma` is 768-dim,
  `text-embedding-3-large` is 3072-dim. Switching providers invalidates the
  vector index in `companies_vec`. We need a re-embed migration when users
  switch — easier to just lock the embedder per install.
- Apple Silicon vs Intel: gemma3:4b runs ~3× faster on M-series. On older
  Intel Macs we should auto-downgrade to `gemma3:1b`.
- Model registry: keep the list of "approved" models in
  `packages/ai-provider/models.json` so the renderer Settings page can show
  size + capability hints.
