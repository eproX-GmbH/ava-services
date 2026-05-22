# AVA als Server-Deployment (deferred)

**Status:** Konzept eingefroren, Implementierung später. Stand: 2026-05-22.

Diese Datei hält den Stand der Architektur-Diskussion zum Thema
"AVA headless auf einem Server, Chat-Provider als Interface" fest,
damit der Kontext bei späterer Wiederaufnahme nicht verloren ist.

## Use-Case

AVA läuft heute als Electron-Desktop-App. Frage: Wie deployed man
AVA auf einem Server, sodass Bedienung über Chat-Provider (Email,
Telegram, später WhatsApp) statt über die UI passiert?

Zielgruppe: technisch versierte Self-Hosters, die selbst deployen.

## Scope-Entscheidungen (festgezurrt)

| Frage | Entscheidung | Begründung |
|---|---|---|
| User-Modell | **Single-User pro Container** | Wer für N Kunden hostet, deployed N Container. Multi-User-Isolation wäre ~3× Aufwand und nicht der Use-Case. |
| Chat-Provider MVP | **Telegram + Email** | Telegram = niedrigster Aufwand × höchster UX-Wert. Email = IMAP/SMTP-Code existiert schon, universell. |
| Producer-Subprozesse | **Mit (volle Feature-Parity)** | Container hat alle 6 Producers. ~500 MB größeres Image, aber kein Feature-Loss vs. Desktop. |
| Bootstrap-Modus | **Beide (YAML + Web-Wizard)** | YAML für Power-User, Wizard als Standard. Verschoben — wird zum Implementierungs-Zeitpunkt finalisiert. |

## Architektur-Skizze

Saubere Paket-Aufteilung:

```
@ava/core         — Headless: Agent, Tools, Knowledge-Adapters, Skills,
                    PGlite, LLM-Provider, Producer-Supervisor
                    Heute: services/desktop/src/main/  (minus Electron-spezifisches)

@ava/desktop      — Electron-Shell + React-Renderer (heutige App)
                    hängt von @ava/core ab

@ava/server (neu) — Headless-Wrapper um @ava/core
                    + Chat-Provider-Layer
                    + Web-Setup-Wizard
                    + Docker-Image
```

### Was Electron-spezifisch ist und ein Interface braucht

| Heute | Server-Replacement |
|---|---|
| `safeStorage` (OS-Keychain) | `CredentialStore`-Interface: Disk-AES + Key aus ENV oder Docker-Secret |
| `Notification` (OS-Toast) | Chat-Provider sendet Nachricht |
| `app.getPath()`, `app.isPackaged` | Config-Layer mit XDG-Pfaden / `process.env` |
| Producer-Spawn via `process.execPath` + `ELECTRON_RUN_AS_NODE=1` | Plain `node` (im Container nativ) |
| Auto-Updater | weg — `docker pull` ist der Updater |
| Login via Keycloak | weg (Single-User) |

### Was komplett neu ist

- Web-Setup-Wizard (Express + kleine React-SPA) für Erst-Konfiguration
- Chat-Provider-Layer (Interface + Adapter pro Provider)
- AttachmentResolver (provider-agnostisch, reused PDF/DOCX/XLSX/Whisper)
- Health-Endpoint, Audit-Log-Sink, Backup-Skripte

## Chat-Provider-Layer

```ts
interface ChatProvider {
  start(): Promise<void>;
  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void;
  sendMessage(chatId: string, content: OutgoingMessage): Promise<void>;
  sendTyping(chatId: string): Promise<void>;
  fetchAttachment(ref: AttachmentRef): Promise<Buffer | NodeJS.ReadableStream>;
}

interface IncomingMessage {
  chatId: string;
  from: string;
  text?: string;
  attachments: AttachmentRef[];
  threadId?: string;
  providerMessageId: string;
}
```

### MVP-Provider

**Telegram:** Bot-API via `node-telegram-bot-api` oder `grammy`,
polling oder webhook. Markdown nativ. Inline-Keyboards für
ask_user_choice. Voice-Messages → Whisper-Pipeline. Files via
getFile-API.

**Email:** IMAP-Pipeline existiert schon in `mail-supervisor.ts` —
recyclen. Outbound via SMTP. Thread-Mapping via In-Reply-To-Header.
Confirm-Roundtrips: `JA`/`NEIN`-Reply-Mail (max. 1 pending confirm
per Email-Thread, sonst Stalls).

## Bootstrap-Modi (beide vorgesehen)

### Modus A — YAML-Config

`ava.config.yaml` im Working-Directory mit `${ENV_VAR}`-Substitution:

```yaml
llm:
  provider: anthropic
  apiKey: ${ANTHROPIC_API_KEY}
  model: claude-sonnet-4-6

chatProviders:
  - kind: telegram
    botToken: ${TELEGRAM_BOT_TOKEN}
    allowedChatIds: [123456789]   # Pflicht — ohne ignoriert AVA alle Messages

  - kind: email
    imap: { host: imap.gmail.com, user: ..., password: ${IMAP_PASSWORD} }
    smtp: { ... }
    allowedSenders: ["du@deinedomain.de"]

integrations:
  hubspot: { oauthRefreshToken: ${HUBSPOT_REFRESH} }
  notion: { token: ${NOTION_TOKEN} }
```

### Modus B — Web-Setup-Wizard

Container exposed `0.0.0.0:8080` während Setup, Browser → 4-Step:

1. LLM-Provider (Connection-Test)
2. Chat-Provider (Bot-Token, Test-Nachricht, Owner-Chat-ID erfassen)
3. Integrations (OAuth-Flows — Redirect zurück auf öffentliche HTTPS-URL)
4. Owner-Verifikation ("Schreib jetzt an deinen Bot")

Nach Setup wechselt Port 8080 in Production-Mode (nur `/health` +
passwort-geschütztes Re-Config).

## Attachments-Pipeline

```ts
class AttachmentResolver {
  async resolve(ref: AttachmentRef): Promise<ResolvedAttachment> {
    // 1. Provider-Adapter fetched bytes
    //    (Telegram getFile / Email MIME-decode / WhatsApp media-URL)
    // 2. Schreibt in /tmp/ava-attachments/<sha256> mit TTL
    // 3. MIME-Detection (file-type-Library)
    // 4. Extractor-Routing:
    //    - PDF      → pdf-parse        (haben wir)
    //    - DOCX     → mammoth          (haben wir)
    //    - XLSX     → xlsx             (haben wir)
    //    - Image    → base64-DataURI für Vision-LLM (haben wir)
    //    - Audio    → whisper          (haben wir)
    //    - Text/CSV → utf-8 lesen
    //    - sonst    → "kann ich nicht lesen, ignoriere"
    // 5. Returnt { kind, text?, base64DataUri?, originalName, size, mime }
  }
}
```

Refactor: Extraktoren aus `mail-attachments.ts` hochziehen nach
`@ava/core/attachments/`, damit Chat-Provider und Mail-Pipeline
denselben Code nutzen.

## Risiken und Reibungspunkte

1. **Skills mit `ask_user_choice`.** Telegram-InlineKeyboard ja, Email
   nein → `ConfirmationBridge`-Interface, das je nach Provider Inline-
   Buttons oder einen Text-Quick-Reply rendert. Email-Confirm via
   Reply-Mail-Roundtrip (≤1 pending pro Thread).

2. **Streaming-Updates.** Token-für-Token wie im Desktop geht über
   Chat schlecht. Telegram: throttled `editMessageText` (alle ~2s).
   Email: nur Final-Reply.

3. **Voice-Input via Telegram.** Whisper-Modelle ~2 GB → Image-Größe.
   Lösung: Lazy-Download beim ersten Voice-Input ODER Whisper als
   Sidecar-Container.

4. **Producer-Subprozesse im Container.** Plain Node statt
   `ELECTRON_RUN_AS_NODE=1`. `producer-supervisor.ts` braucht
   minimalen Refactor (Code-Pfad-Switch über `process.versions.electron`).

5. **PGlite + Container-Restarts.** Single Volume-Mount auf `/data`.
   Memory + Conversations bleiben erhalten. Backups: Operator-Doku.

6. **HubSpot-OAuth-Redirect.** Redirect-URL muss öffentliche HTTPS-
   URL des Containers sein → Operator passt HubSpot-App-Settings
   an. Doku, kein Code.

7. **End-to-End-TLS.** AVA macht kein HTTPS — Operator terminiert
   via Caddy/Traefik/Nginx davor. Klar dokumentieren.

8. **Anthropic-Subscription via OAuth.** Token aus Browser-Login →
   muss man dem Server händisch übergeben. Server-Deploys nutzen
   besser API-Key-Modus.

9. **Chat-Provider als Auth.** Pflicht-Allowlist von Chat-IDs/
   Sender-Emails. Ohne diese kann jeder, der die Bot-Adresse rät,
   AVA-Commands (inkl. HubSpot-Delete!) ausführen. Im Code als
   Hard-Stop, nicht als Soft-Warning.

## Implementierungs-Phasen (wenn wir loslegen)

### Phase 1 — Foundation (~1–2 Wochen)
- `@ava/core` als pnpm-Workspace-Package extrahieren
- `CredentialStore`-Interface + EncryptedFile-Implementierung
- Identifizieren wo `electron`/`app`/`safeStorage` im Code referenziert wird
- Producer-Supervisor electron-agnostisch machen
- Bestehende Desktop-App via `@ava/core` weiter funktional halten (= keine Regression)

### Phase 2 — Server-Skeleton (~1 Woche)
- `services/server/` mit Express + Telegram-Bot-Adapter (`grammy`)
- Modus A (YAML-Config) zuerst — schneller zum funktionierenden Prototyp
- Single-User-Auth via Allowlist
- Dockerfile + docker-compose.yml mit Ollama-Sidecar + PGlite-Volume

### Phase 3 — Email-Provider + Attachments (~3–5 Tage)
- Email-Adapter via bestehender IMAP/SMTP-Pipeline
- Generischer AttachmentResolver, Extraktoren hochziehen nach @ava/core
- Confirm-via-Reply-Mail für Email-Provider

### Phase 4 — Web-Setup-Wizard (~1–2 Wochen)
- Express + React-SPA auf Port 8080
- 4-Step Setup-Flow
- OAuth-Callbacks auf öffentliche HTTPS-URL umstellen

### Phase 5 — Polish + Doku
- Health-Endpoint, Metrics, Structured-Logs
- Backups-Doku, Operator-Runbook
- Rate-Limiting pro Chat-User
- HubSpot/Notion-OAuth-Setup-Anleitung mit Server-URL

### Phase 6 — Erweiterte Provider (optional, später)
- Matrix (selbsthostbar — passt zur Self-Deploy-Philosophie)
- WhatsApp via Twilio (offiziell, kostet)
- WhatsApp via WAHA/Baileys (Account-Ban-Risiko — nur Doku, kein offizieller Support)
- Slack/Discord/Teams

## Realistische Aufwand-Schätzung

- **Scope-aggressiv (nur Telegram, nur YAML, keine Wizard):** 5–7 Tage MVP
- **MVP wie hier skizziert (Telegram + Email + YAML + Wizard):** 3–4 Wochen
- **Bis Phase 5 Production-Ready:** 6–8 Wochen

## Was VOR dem Implementations-Start zu klären ist

- [ ] Aktuelle Electron-Imports kartieren (was muss hinter Interface, was geht weg)
- [ ] Anthropic-Subscription-Modus auf Server: wie übergibt man den OAuth-Token?
- [ ] Producer-Image-Größe: bleibt Single-Image oder Tier-1/Tier-2?
- [ ] Whisper im Image vs. Lazy-Download
- [ ] PGlite-Migration-Strategie bei Schema-Updates (heute via Electron-First-Run; im Container?)
- [ ] OAuth-Redirect-URI für HubSpot/Notion (öffentliche HTTPS-URL des Servers)
