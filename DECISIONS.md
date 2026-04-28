# AVA Cloud → Desktop — Architekturentscheidungen

> Erstellt: 2026-04-21 | Schritt 2 der Transition  
> Basis: `INVENTORY.md` vom gleichen Datum  
> Status: **Entwurf — wartet auf User-Freigabe pro Entscheidung**

**Rahmenbedingungen (fixiert durch User):**
- Online immer required — keine Offline-Fähigkeit nötig
- Postgres bleibt managed auf fly.io (Gateway-Pattern)
- Elasticsearch bleibt managed bei elastic.co
- `business-intelligence` und `user-interface` aus Scope
- LLM-Ziel: Gemma-Class ~4B via Ollama, Provider über AI SDK austauschbar

---

## D1 — Queue-Technologie

**Kontext:** Aktuell RabbitMQ (Cloud/fly.io). Für Desktop-Bundling braucht es eine Queue, die als Single-Binary plattformübergreifend mitgeliefert werden kann. Muss Topic-basiertes Routing, Persistenz und ACK-Semantik bieten (wie im aktuellen `@ava/event`-Client).

**Optionen:**

| | RabbitMQ | NATS JetStream | Redis Streams |
|---|---|---|---|
| Binary-Size | ~100MB (Erlang VM) | **~15MB (Go, single binary)** | ~10MB (C, single binary) |
| Persistenz | ja | ja (JetStream) | ja (RDB/AOF) |
| Topic-Routing | Exchange/Routing-Keys | Subject-Hierarchie (`a.b.c`) | Consumer-Groups + Streams, weniger ergonomisch |
| ACK/NACK | ja | ja | via XACK, etwas klobig |
| Node.js-Client | `amqplib` (bestehend) | `@nats-io/nats-core` (aktiv) | `ioredis` |
| Embedded-Start | problematisch | **trivial (`exec`)** | trivial (`exec`) |

**Empfehlung: NATS JetStream**

Begründung:
- **Single-Binary ~15MB** lässt sich sauber plattformspezifisch bündeln, keine Runtime-Dependency (Erlang entfällt)
- **Subject-Hierarchie** ist direktes Äquivalent zu RabbitMQ-Topic-Exchanges — die Mapping-Arbeit im `@ava/event`-Wrapper bleibt überschaubar
- **JetStream** liefert Persistenz + Stream-Replay out-of-the-box, das deckt die aktuelle "prefetch=1 + manual ACK"-Semantik ab
- Streams sind besser geeignet für das aktuelle Pipeline-Muster (ein Event triggert den nächsten Schritt) als Redis-Streams

**Migrationspfad:**
- `lib/events/` bleibt bestehen und behält RabbitMQ-Pfad (für Cloud-Parity)
- Neuer `packages/queue-client/` mit identischem Interface, Implementierung per ENV (`QUEUE_DRIVER=rabbitmq|nats`)
- Desktop bundelt nur den NATS-Pfad

---

## D2 — Meta-Repo-Strategie

**Kontext:** Jeder Service ist ein eigenes Git-Repo. User-Prinzip: Service-Isolation bleibt erhalten (keine Zwangs-Konsolidierung).

**Optionen:**

| | Git Submodules + pnpm Workspaces | Turborepo | Nx |
|---|---|---|---|
| Git-Historie pro Service | **bleibt erhalten** | konsolidiert | konsolidiert |
| Invasivität | minimal | groß | sehr groß |
| Build-Caching | manuell | eingebaut | eingebaut |
| Shared Packages | pnpm-Symlinks | Workspace-Protokoll | Workspace-Protokoll |
| Cloud-Parallel-Deployment | **unverändert möglich** | erfordert Neuaufsetzen | erfordert Neuaufsetzen |

**Empfehlung: Git Submodules + pnpm Workspaces**

Begründung:
- Jeder Service bleibt eigenständig deploybar auf fly.io während der Transition
- Git-Historien bleiben erhalten, keine Big-Bang-Umstellung
- pnpm-Workspace-Symlinks genügen, um `packages/ai-provider`, `packages/queue-client`, `packages/db-client` aus allen Services zu konsumieren
- Turborepo kann später optional als reiner Cache-Layer darübergelegt werden, falls Build-Zeiten Probleme machen (non-invasiv, kein Lock-in)

**Konkretes Layout:**
```
ava-services/ (Meta-Repo, eigenes Git)
├── .gitmodules
├── pnpm-workspace.yaml
├── package.json (root, devDeps only)
├── services/
│   ├── company-contact/       # Submodule
│   ├── company-evaluation/    # Submodule
│   └── ... (7 Services)
├── packages/
│   ├── ai-provider/
│   ├── queue-client/
│   └── db-client/
└── lib/
    └── events/                # bleibt, wird zum Referenz-Kern des queue-client
```

---

## D3 — Postgres-Zugriff (vom User vorentschieden: Option B)

**Entscheidung:** Thin API-Gateway auf fly.io — bestätigt.

**Detaillierung:**

| Aspekt | Wahl |
|---|---|
| Framework | **Hono** (kleiner, schneller als Express, TypeScript-first, gleiche Lernkurve) |
| Protokoll | REST mit OpenAPI-Schema — konsistent zu bestehenden Services |
| Auth | JWT mit Access-Token (15min) + Refresh-Token (7d), pro Kunde eigenes Signing-Key-Paar |
| Secrets-Store | fly.io Secrets pro Kunde/Env |
| DB-Access | Prisma (gleicher Schema-Stand wie Services) |
| Audit-Log | separate `audit_log`-Tabelle, append-only, pro Request |
| Rate-Limit | pro Kunde, Sliding-Window im Redis (oder einfacher: in-memory pro Instance — reicht anfangs) |
| Versionierung | `/v1/...` im Pfad, OpenAPI-Spec mitgeführt |

**Alternative erwogen:** tRPC statt REST — verworfen, weil die bestehenden Services alle Swagger/OpenAPI nutzen, das bleibt konsistent.

**Wichtiger Punkt:** Der Gateway bekommt nicht den vollen CRUD-Scope des gesamten Postgres-Schemas, sondern nur die Operationen, die die Desktop-App tatsächlich braucht. Scope wird in Schritt 5 aus dem Datenfluss der Desktop-App abgeleitet — nicht vorweg alles durchpipen.

---

## D4 — Embeddings (geklärt: bleiben in der Cloud via OpenAI)

**Entscheidung (User 2026-04-21):** Embeddings bleiben vorerst **OpenAI `text-embedding-3-large` (3.072 Dim) via Cloud-API**. Kein lokales Embedding-Modell in der initialen Desktop-Version.

Begründung:
- Online-Anforderung gilt ohnehin → OpenAI-API-Call ist zulässig
- Kein Re-Embedding-Job nötig, bestehende Vektoren bleiben gültig
- Schema bleibt unverändert (3.072 Dim in Postgres)
- Eliminiert den kritischsten Qualitätsrisiko-Pfad der Migration

**AI-SDK-Abstraktion trotzdem nötig:**
`getEmbedder()` in `packages/ai-provider` bleibt im Design — aber mit Default `openai` und ohne Ollama-Zwang. Das hält die Tür offen, später auf lokale Embeddings zu wechseln, ohne dass es jetzt Arbeit kostet.

**Zukunfts-Pfad (nicht Teil der Transition, nur dokumentiert):**
Wenn irgendwann lokales Embedding gewünscht wird, sind die technischen Konsequenzen:
- Zero-Padding kleinerer Dims auf 3072 funktioniert **nicht** sauber für Cosine-Similarity (alte OpenAI- und neue zero-padded Vektoren liegen in unterschiedlichen Unterräumen — Scores werden verzerrt)
- Sauberer Pfad: DB-Schema um `embedding_version`-Spalte erweitern, Re-Embedding-Job auf fly.io, Modell-Wechsel als atomares Release
- Das ist ein eigenes Projekt, nicht Teil der Desktop-Transition

---

## D5 — Service-Start-Modell in Electron

**Kontext:** 7 Node.js-Services müssen im Electron-Main-Prozess lebendig gehalten werden. Aktuell ist jeder Service ein eigener Node-Prozess.

**Optionen:**

| | `fork()` Child-Prozesse | Worker-Threads | In-process Module |
|---|---|---|---|
| Code-Änderungen nötig | **keine** | viele (shared state, kein separates `require.main`) | sehr viele |
| Prozess-Isolation | **voll** | nur V8-Isolate | keine |
| Crash-Recovery | per Service möglich | ein Crash killt alles | ein Crash killt alles |
| Speicher-Overhead | ~50MB × 7 = ~350MB | gering | minimal |
| Debugging | nativ pro Prozess | tricky | einfach |

**Empfehlung: `fork()`-Child-Prozesse mit Supervisor**

Begründung:
- Services laufen **komplett unverändert** — jede Migration ist reversibel, jede Fehlersuche deckt sich mit Cloud-Verhalten
- Prozess-Isolation = ein abstürzender Service killt nicht die App
- 350MB zusätzlicher RAM ist auf einem Business-Desktop unproblematisch
- Dev-Prod-Parität: `scripts/dev.sh` startet dieselben Services als normale Node-Prozesse, Electron tut gleiches via `fork()`

**Supervisor-Verantwortung (Stichpunkte für Schritt 6):**
- Spawn, Restart-on-Crash mit Exponential-Backoff
- Graceful Shutdown (SIGTERM → warten → SIGKILL)
- Log-Aggregation zu zentraler Datei + Renderer-UI
- Health-Check-Endpoint-Polling pro Service
- Port-Allocation (alle Services lauschen auf freien localhost-Ports, Renderer kennt Map)

---

## D6 — Lokaler State / App-interne Persistenz

**Kontext:** Desktop-App braucht minimalen lokalen State (Login-Token, UI-Settings, evtl. Embedding-Cache). Postgres bleibt remote.

**Optionen:**

| | SQLite (`better-sqlite3`) | JSON-Datei | electron-store |
|---|---|---|---|
| Strukturiert | ja | schwach | schwach |
| Query-fähig | ja | nein | nein |
| Native-Binary | ja (vorhanden) | — | — |

**Empfehlung: `better-sqlite3` im Electron-`userData`-Verzeichnis**

Nutzung:
- `auth`-Tabelle: Access/Refresh-Token, Kunden-ID
- `settings`-Tabelle: UI-Präferenzen
- Optional: `embedding_cache` für Hot-Items, falls Ollama-Recompute-Kosten spürbar werden (abwarten — nicht vorab bauen)

Keine Geschäftsdaten lokal. Keine lokalen Migrationen komplexer als einfache DDL-Scripts.

---

## D7 — Ollama-Runtime-Bundling

**Kontext:** Ollama stellt die Laufzeit für das lokale LLM (und optional Embedding). Muss plattformübergreifend ausgeliefert werden.

**Optionen:**

| | Offizieller Ollama-Installer | Ollama-Server-Binary gebündelt |
|---|---|---|
| Setup-UX | separater Install-Schritt | **integriert in First-Run** |
| Versionskontrolle | Kunde-seitig | **App-seitig fixiert** |
| Update-Kontrolle | Ollama-autoupdate | **App-Auto-Update bindet Version** |
| Plattform-Binaries | vorhanden | müssen mitpaketiert werden |

**Empfehlung: Ollama-Server-Binary bündeln, vom Supervisor als Child-Prozess starten**

Begründung:
- First-Run-Experience ohne Extra-Installations-Schritt
- App garantiert eine getestete Ollama-Version
- Modell-Download (Gemma + EmbeddingGemma) wird vom Supervisor via Ollama-HTTP-API orchestriert, mit UI-Fortschritt

**Offen (kein Blocker für Schritt 2):** Lizenzierung der Ollama-Binaries im Kunden-Paket kurz prüfen (Ollama ist MIT — aber die gebündelten Modelle haben eigene Lizenzen: Gemma-Terms-of-Use sind kommerziell permissiv, formell prüfen).

---

## D8 — AI Provider Factory-Muster (AVA-Variante vom QUIKK-Muster)

**Kontext:** QUIKK nutzt eine Factory, die einen `OpenAIProvider | MistralProvider` zurückgibt, der Model-String wird separat übergeben. Der Blueprint im Plan liefert direkt ein fertiges Modell via `getLLM()`.

**Empfehlung: Blueprint-Stil (`getLLM()` / `getEmbedder()`) — leicht abweichend von QUIKK**

Begründung:
- AVA hat keine per-Organization-Provider-Auswahl wie QUIKK (aiFactory nahm eine `organizationId`). In AVA ist die Wahl pro Deployment/Kunde fix via ENV.
- Einfachere Ergonomie in den Services — kein doppelter Dispatch (erst Provider, dann Model)
- Austauschbarkeit bleibt voll gegeben

**Blueprint-Signatur:**
```ts
// packages/ai-provider/src/index.ts
export function getLLM(): LanguageModel;           // Chat/Completion
export function getEmbedder(): EmbeddingModel;     // Embedding
// Alles ENV-gesteuert: LLM_PROVIDER, LLM_MODEL, EMBED_PROVIDER, EMBED_MODEL
```

**Unterstützte Provider:**
- `openai` (Cloud-Fallback, für aktuellen Regressionstest-Parity)
- `anthropic`
- `google` (Gemini)
- `ollama` (Desktop-Default)

---

## D9 — Electron-Build-Toolchain

**Bewusst aufgeschoben auf Schritt 6**, aber vorab gefragt:

**Vorläufige Empfehlung: `electron-forge`**

Begründung:
- Erstklasse-Support für Windows Code-Signing + macOS Notarization
- Plugin-System für Extra-Resources (Ollama-Binary, NATS-Binary, Modelle)
- Auto-Update via `electron-updater` gut integriert

Alternative `electron-builder` bleibt offen, entscheidungsreif erst, wenn wir Schritt 6 angehen.

---

## D10 — Prompt-Kompatibilität OpenAI → Ollama

**Offener Punkt, Risiko-Warnung:**

Die OpenAI-Calls in `company-evaluation` und `company-publication` nutzen vermutlich:
- **JSON-Mode / Structured Outputs** (`response_format: { type: "json_object" }`)
- **Tool-Calling / Function-Calling**
- **System-Prompts mit OpenAI-spezifischen Eigenheiten**

Gemma via Ollama unterstützt:
- JSON-Mode via Ollama `format: "json"` — funktional äquivalent, aber weniger streng als OpenAI Structured Outputs
- Tool-Calling — eingeschränkter Support je nach Modell-Variante

**Vorgehen im Pilot (Schritt 3):**
- In `company-contact` zuerst auditieren, welche OpenAI-spezifischen Features genutzt werden
- Pro genutztem Feature: AI-SDK-Äquivalent finden, oder Fallback-Adapter
- Regressions-Eval mit echten Produktions-Fixtures gegen Ollama, **bevor** auf die großen Services (`evaluation`, `publication`) ausgerollt wird

---

## D11 — Offline-Verhalten (vom User fixiert: Online-only)

**Entscheidung:** Keine Offline-Fähigkeit. Desktop-App prüft beim Start Konnektivität zu:
- DB-Gateway (fly.io)
- Elasticsearch (elastic.co)
- Externe APIs, die der aktive Workflow braucht (ValueSERP etc.)

Fehlt Konnektivität: klare Fehlermeldung im UI, App geht nicht in degraded mode. Das vereinfacht das Design massiv (kein Outbox-Pattern, keine Conflict-Resolution, keine lokale Write-Queue).

**Implikation für Schritt 4:** `packages/db-client` braucht keine Offline-Semantik, keine lokale Queue — nur klaren Fehler-Propagation-Pfad.

---

## D12 — AI SDK by default; direct provider SDKs only as documented exception

**Kontext:** Beim Aufbau des Desktop-Agenten (Phase 8) und der Self-Service-Provider-Wahl wurde nochmal sichtbar, dass AVA grundsätzlich auf Vercel AI SDK steht (`packages/ai-provider`). Mehrere Services nutzen aber zusätzlich den **direkten** OpenAI-SDK (`openai` v4/v6) — das ist *kein* Versehen, sondern bewusste Ausnahme für Features, die AI SDK nicht abdeckt.

**Regel:**

1. **Default: AI SDK über `@ava/ai-provider`.** Jeder neue LLM-/Embedding-Aufruf geht über `getLLM()` / `getEmbedder()` (env-gesteuert) bzw. `createLLM(...)` / `createEmbedder(...)` (runtime-gesteuert, Phase 8.k). Damit bleibt die Provider-Wahl austauschbar (OpenAI, Anthropic, Google, Mistral, Ollama).
2. **Ausnahme: direkter Provider-SDK** ist erlaubt, wenn AI SDK das benötigte Feature nicht ausdrückt. Aktuell dokumentierte Ausnahmen:
   - `services/website` — **OpenAI Deep Research** (`responses.create()` mit `o4-mini-deep-research-*`, `web_search`-Tool, Responses-API). Kein AI-SDK-Provider wrappt die Responses-API.
   - `services/website/.../public-companies-extractor` — Place-Matching via `gpt-5-mini` mit OpenAI-spezifischen Strukturhinweisen.
   - `services/company-evaluation` — direkter `OpenAI`-Client wird per DI durchgereicht, aber heute **nicht** für Calls genutzt; alle Embeddings/Generationen laufen über AI SDK. Halten wir als Vorbereitung für künftige Realtime-/Batch-API-Nutzung.
3. **Gegen die Regel verstoßen heißt:** im Code-Header des Aufrufers begründen *warum* AI SDK nicht reicht (welches API/Feature fehlt) und einen `// @ai-sdk-exception:` Marker setzen, damit Audits die Stellen finden.
4. **Auswahl-Filter im Desktop-Agenten:** Nur Modelle, die AI SDK unterstützt, sind im Provider-Picker selektierbar. Direkt-SDK-Features sind kein User-Switch — sie sind Pipeline-intern.

**Begründung:**

- Eine zentrale Provider-Stelle hält die Switch-Kosten (neuer Vendor) bei einem einzigen Adapter.
- Direktclient-Abenteuer (z.B. Deep Research) sind nützlich, aber gehören klar markiert, sonst wandert die Codebasis schleichend zurück zu vendor-lock-in.
- Damit ist auch die Aussage gegenüber Kunden sauber: *"alle Standard-Calls laufen über austauschbare Provider; spezialisierte OpenAI-Features (Deep Research) sind als solche gekennzeichnet."*

**Bekannte Limits von AI SDK (Stand 2026-04):**

| Feature | AI SDK? | Workaround |
|---|---|---|
| `streamText` / `generateText` mit Tools | ✅ | — |
| `generateObject` mit JSON-Schema | ✅ | — |
| `embed` / `embedMany` | ✅ (OpenAI/Google/Ollama) | — |
| OpenAI Responses-API (`o4-mini-deep-research`) | ❌ | direkter `openai`-SDK |
| OpenAI Realtime (Voice) | ❌ | direkter `openai`-SDK |
| OpenAI Batch | ❌ | direkter `openai`-SDK |
| OpenAI Assistants v2 (Threads/Runs) | ❌ (außer Scope) | nicht genutzt |

---

## Offene Rückfragen — geklärt (User 2026-04-21)

1. **D4:** ✅ Embeddings bleiben Cloud/OpenAI. Kein Referenz-Datensatz nötig.
2. **D10:** ✅ OpenAI-Call-Audit im Pilot genehmigt.
3. **D3:** ✅ Gateway-Scope wird in Schritt 5 parallel zur Electron-App-Spec definiert.
4. **Pilot:** ✅ **`company-profile`** statt `company-contact` — validiert früh den Embedding-Pfad über AI-SDK.

---

*Schritt 2 abgeschlossen. Übergang zu Schritt 3 (AI-SDK-Migration, Pilot: `company-profile`).*
