# Plan: AVA cloud-fähig machen, ohne den Kern umzubauen

Stand 2026-10-09 (Desktop v0.1.786). Recherche auf Anstoß des Operators:
OpenClaw 2.0 läuft seit August auf eigenen Servern statt nur lokal. Frage:
Wie bekommt AVA dieselbe Fähigkeit, mit allen Producern samt Browser, ohne
die Architektur umzuwerfen? Ergänzt und ersetzt in Teilen
`docs/PLANS_server_deployment.md` (2026-05-22, eingefroren) und
`docs/PLAN_WORKFLOWS_OHNE_APP.md` (Option B).

Status: Refactoring (§12) freigegeben 2026-10-09 mit den Vorschlägen aus §12.5
(R1/R2 vor dem MCP-Relais, Wächter build-blockierend, `core/` als Verzeichnis).
**R1 in v0.1.787**, **R2a (IPC nach Domänen) in v0.1.788**, **R2b (bootstrapCore) in v0.1.789**, **R3 (Server-Einstieg) in v0.1.790**, **R4 (Setup-Seite, fensterlose Ersatzwege) in v0.1.791** (§12.6–§12.10).

## 1. Kurzfassung

- **Das Ziel ist näher als gedacht.** Die sechs Producer sprechen heute schon
  die Cloud-Datenbank (MPG) und CloudAMQP, nicht PGlite. Lokal bindet sie nur
  dreierlei: der Start über die Electron-Binary, der Chrome-Pfad und die
  LLM-Umgebung (Ollama-Adresse, Schlüssel, Loopback-Token). Der
  Register-Delta-Worker auf Fly beweist seit September, dass genau dieser
  Code mit Chromium in einem Alpine-Container läuft.
- **Der Hauptprozess ist der eigentliche Brocken, nicht die Producer.**
  88 von 274 Dateien importieren `electron`, aber fast alle nur für
  `app.getPath`. Die Dienste selbst (Orchestrator, Workflows, Scheduler,
  Heartbeat, Telegram, IMAP) sind Electron-frei. Hart gekoppelt sind fünf
  Stellen: versteckte Fenster als Scraping- und Decoder-Engine, safeStorage
  als einzige Geheimnis-Ablage, interaktive Anmeldung im Fenster, der
  Producer-Spawn über `process.execPath`, und die 7.962 Zeilen Verdrahtung in
  `src/main/index.ts`.
- **OpenClaws Modell passt auf AVA fast eins zu eins:** ein Gateway je
  Vertrauensgrenze, das Agent und Zustand hält; Clients, die sich verbinden;
  und „Nodes“, also Geräte des Nutzers, die dem Gateway Browser, Mikrofon
  und Fenster leihen. Für AVA heißt das: *AVA-Kopf* im Container, Desktop,
  Telegram und MCP als Clients, der eigene Rechner optional als Node für
  alles, was eine Person vor einem Fenster braucht (LinkedIn, Logins).
- **Empfehlung:** vier Stufen, jede für sich nutzbar. Stufe 0 (Producer im
  Container, Kopf bleibt lokal) ist in rund einer Woche machbar und
  entlastet sofort schwache Laptops. Stufe 1 (Kopf headless) ist der
  eigentliche Cloud-Modus, rund vier Wochen. Stufe 2 macht die bestehende
  Oberfläche zum Web-Client. Stufe 3 (Node-Modus) später.
- **Ein Container je Nutzer, nicht ein Dienst für alle.** Das war schon die
  Entscheidung im Server-Plan und ist auch OpenClaws Haltung („one gateway
  per trust boundary“). Compute-Lokalität wird dabei von „Gerät des
  Nutzers“ zu „Hoheit des Nutzers“ umformuliert: eigener Server oder ein ihm
  zugeordneter Container, in den er seine Schlüssel selbst einbringt.

## 2. Was OpenClaw 2.0 tatsächlich macht

Quellen: Docker-Installationsseite, Remote-Gateway-Seite, Nodes-Seite und
Browser-Seite der OpenClaw-Doku; Fly-Blueprint; Pressestimmen zum Release
v2026.8.1 (30.08.2026). Siehe §10.

| Baustein | OpenClaw | Bedeutung für AVA |
|---|---|---|
| **Gateway** | Ein Prozess hält Sitzungen, Zustand, Kanäle (Telegram, WhatsApp, Discord) und führt den Agenten aus. Bindet standardmäßig an loopback:18789, als Daemon oder Container. | Entspricht dem AVA-Hauptprozess ohne Fenster: Orchestrator, Werkzeuge, Workflows, Scheduler, Telegram, Mail. |
| **Clients** | CLI, TUI, Control UI im Browser, macOS-App, WebChat. Verbinden sich per WebSocket mit Token oder Passwort; nach dem Pairing speichert der Client ein Gerätezertifikat. | Desktop-Renderer, Telegram, MCP-Clients. Die Oberfläche bleibt, nur der Transport ändert sich. |
| **Nodes** | Begleitgeräte (Mac, iPhone, Android, headless Rechner) melden sich mit `role: node` und bieten Befehle an: Kamera, Bildschirm, `system.run` mit Allowlist, Benachrichtigungen, Standort, lokale Modelle. Das Gateway ruft sie per `node.invoke`. Nodes müssen explizit freigegeben werden. | Der Rechner des Nutzers als Peripherie: LinkedIn-Fenster (Personenkonto), Mikrofon, interaktive Logins, bei Bedarf der lokale Browser. |
| **Browser** | Zwei Wege: ein vom Gateway verwalteter Chromium (Docker-Tags `-browser` bringen Chromium und Xvfb mit) oder der **Node-Browser-Proxy**: läuft auf dem Rechner mit Browser ein Node-Host, leitet das Gateway Browser-Aktionen ohne Zusatzkonfiguration dorthin. Das ist für Remote-Gateways der Standardweg. Zusätzlich Remote-CDP (Browserless, Browserbase). | Für die Producer braucht der Container eigenen Chromium (wie der Register-Worker). Der Node-Proxy ist das Muster für alles, was auf dem Rechner der Person bleiben muss. |
| **Betrieb** | Docker-Image mit Volume unter `/home/node/.openclaw`, Health-Endpunkte `/healthz`, `/readyz`, Token in `.env`. Fly-Blueprint: `shared-cpu-2x`, 4 GB, Volume `/data`, Wrapper mit `/setup`-Assistent, rund 20–25 $ im Monat. | Vorlage für Image, Volume, Health und Erst-Einrichtung. |
| **Sicherheit** | „Ein Gateway = eine Vertrauensgrenze.“ Für fremde Nutzer getrennte Gateways, idealerweise getrennte OS-Nutzer oder Hosts. Container binden standardmäßig nach außen und brauchen deshalb Auth. Sandbox aus. Kritik der Presse an 2.0: Mehrspieler-Sitzungen sind keine Mandantentrennung, Secret Store unverschlüsselt, Sandbox nicht automatisch. | Bestätigt: ein Container je Nutzer. Lektionen: Geheimnisse verschlüsselt ablegen, Reverse-Proxy mit TLS davor, Kanal-Allowlisten als harte Sperre. |

Was OpenClaw **nicht** löst und AVA selbst beantworten muss: Mandanten
innerhalb eines Gateways (gibt es nicht), lokale Modelle im Container (es
nutzt Cloud-APIs), und Scraping-Herkunft aus Rechenzentrums-IPs.

## 3. Was AVA heute schon mitbringt

| Baustein | Stand | Fundstelle |
|---|---|---|
| Producer sprechen Cloud-DB und CloudAMQP | seit AGENT_PLAN 8.v3; `DATABASE_URL`/`AMQP_URL` kommen vom Gateway (`/v1/local-credentials`, `/v1/local-amqp-url`) | `services/desktop/src/main/producer-supervisor.ts:715–848`, `index.ts:664–694` |
| Dauerhafte AMQP-Warteschlangen je Nutzer | ein Import wartet auf den nächsten laufenden Producer, egal wo er läuft | `docs/PLAN_MCP_OEFFNUNG.md` §2 |
| Headless Worker mit Chromium auf Fly | `node:20-alpine` + `apk chromium chromium-chromedriver`, nicht als root, `CHROME_BIN` | `packages/register-delta/Dockerfile`, `fly.toml` |
| Producer-Dockerfiles mit Chromium | vorhanden, aber veraltet (node:21, Fly-Apps gelöscht, „LÄUFT NICHT MEHR AUF FLY“) | `structured-content/Dockerfile`, `*/fly.toml` |
| Gemeinsamer Browser-Lebenszyklus | `--ava-browser`, eigenes Profil, `--headless=new`, Aufräumen bei SIGTERM, Download-Sperre per Chrome-Pref | `*/src/infrastructure/browser-lebenszyklus.ts` |
| Aufträge von außen | MCP-Endpunkt `/mcp` mit Keycloak-OAuth, Werkzeuge legen Transaktionen an | v0.1.784–786 |
| Rückmeldung ohne Fenster | Telegram, Alerts `/v1/alerts/neuheiten`, Hintergrundaufgaben, Mail | v0.1.743–752 |
| Dienste Electron-frei | Orchestrator (streamChat läuft im Main), Workflows (RunnerDeps = Funktionen), Scheduler, Heartbeat, Telegram-Client, IMAP, Status-Wächter | `agent/orchestrator.ts:1260`, `workflows/runner.ts:49–62` |
| Dienste pausierbar | Worker-Modus-Register mit `anhalten`/`anlaufen`/`darfLaufen` je Dienst | `worker-modus.ts` |
| Electron-Stub für Tests | Stores und Workflows laden ohne Electron, wenn `app` und `safeStorage` gestubbt sind | `services/desktop/scripts/_electron-stub.mjs` |
| Loopback-Token für Producer | HTTP-Server 127.0.0.1 mit `x-ava-plan-secret`; funktioniert im Container unverändert | `auth/plan-token-server.ts` |

## 4. Was lokal gebunden ist und wie es im Container ersetzt wird

Inventar vom 2026-10-09 (Zählung in `services/desktop/src/main`): 274
Dateien, 88 mit `electron`-Import, 68 mit `app.getPath`, 20 mit
`safeStorage`, 23 mit `BrowserWindow`, 7 mit `Notification`, 3 mit
`ELECTRON_RUN_AS_NODE`. IPC: 317 `ipcMain.handle`, 53 Push-Kanäle, alles
über eine Preload-Datei (2.235 Zeilen).

### 4.1 Grundlagen, die AVA auf dem PC hat und im Container braucht

| Grundlage | Heute (Desktop) | Im Container | Aufwand |
|---|---|---|---|
| **Browser für Producer** | Chrome for Testing, einmalig nach `userData/chrome-for-testing/` geladen; Rückfall auf den Chrome der Person (`chrome-for-testing.ts`) | `apk add chromium chromium-chromedriver` + Fonts, `CHROME_BIN=/usr/bin/chromium`, PATH mit chromedriver, nicht als root (sonst `--no-sandbox`-Tricks). Exakt wie `packages/register-delta/Dockerfile`. `--headless=new` setzen die Producer schon. | klein |
| **Producer-Start** | `spawn(process.execPath, [entry], {ELECTRON_RUN_AS_NODE:1})`, Bundles unter `resources/p/<code>/`, Ports 51010–51060, `lsof`-Aufräumen, Backoff | `spawn("node", …)` aus `/app/producers/<name>/dist/web/api/server.js`; Ports bleiben; `lsof` durch `ss`/Port-Probe ersetzen oder im Container weglassen | klein |
| **LLM** | Ollama gebündelt (`ollama serve` auf 11434, Pflicht `qwen3:8b`, `embeddinggemma`), oder eigener Schlüssel, oder ChatGPT-Abo per Loopback-Token | Ollama als Sidecar (`ollama/ollama`-Image, Volume für Modelle). Ohne GPU reicht CPU für **Embeddings** (embeddinggemma, 620 MB), nicht für Chat und Producer-LLM-Pässe. Standard im Cloud-Modus: eigener Schlüssel, Organisationsschlüssel oder ChatGPT-Abo; lokales Chat-Modell nur mit GPU-Host | klein (Config), GPU = Geld |
| **Whisper** | `whisper-cli` gebündelt, Modelle in `shared/whisper` | optional, Lazy-Download beim ersten Sprach-Eingang (Telegram); ohne Whisper Sprachnachrichten als „nicht lesbar“ beantworten | klein |
| **OGG→WAV** | verstecktes BrowserWindow mit WebAudio (`telegram/audio.ts`) | `apk add ffmpeg` und `ffmpeg -i in.ogg -ar 16000 -ac 1 out.wav` | klein |
| **Lokale Daten** | JSON und PGlite unter `userData` (Chat-Verlauf, Gedächtnis, Workflows, Skills, Alarme, Mail-Speicher, Audit, Usage) | ein Volume `/data`, `AVA_DATA_DIR` statt `app.getPath("userData")`; ein Konto je Container, kein `app.setPath`/Relaunch | mittel (68 Dateien, mechanisch) |
| **Geheimnisse** | `safeStorage` (OS-Schlüsselbund) in rund 10 Stores; teils Klartext-Rückfall | `CredentialStore`-Interface: Desktop = safeStorage, Server = AES-256-GCM-Datei mit Schlüssel aus `AVA_SECRETS_KEY` (Docker-Secret). Lektion aus der OpenClaw-Kritik: nie unverschlüsselt | mittel (10 Stores) |
| **Anmeldung** | Keycloak Authorization Code + PKCE im eigenen BrowserWindow, Loopback-Redirect; Refresh-Token in safeStorage | **OAuth 2.0 Device Authorization Grant** in Keycloak am Client `ava-desktop` (oder neuer Client `ava-server`) aktivieren: Container druckt URL + Code ins Log bzw. die Setup-Seite, Person bestätigt im Browser, Refresh-Token landet im CredentialStore. Kein Fenster, kein Loopback nötig. Alternative: Desktop „koppelt“ den Server und übergibt einen Refresh-Token (OpenClaw-Pairing) | klein–mittel |
| **Sign in with ChatGPT** | BrowserWindow mit `will-redirect` | gleiche Device-Flow-Idee geht nicht (OpenAI). Weg: Login auf dem Desktop oder einem Node, Token-Hülle zum Kopf übertragen (Stufe 3), oder im Cloud-Modus Schlüssel statt Abo | mittel, Stufe 3 |
| **CRM-OAuth** | System-Browser + Loopback, Code-Tausch über Gateway | Redirect auf die öffentliche HTTPS-Adresse des Containers (Setup-Seite) oder Node-Weg | klein, Doku |
| **Benachrichtigungen** | `Notification` (7 Stellen), Broadcast an Fenster | `Notifier`-Interface: Telegram, Alerts, später Web-Client-Push. Broadcast ins Leere ist heute schon unkritisch | klein |
| **Updater, Wachhund, powerMonitor** | electron-updater, eigener Wachhund-Prozess, Schlaf/Aufwachen | `docker pull` + Restart-Policy + `/healthz`; powerMonitor entfällt | klein |
| **Versteckte Fenster als Scraper** | LinkedIn (`scraper-window.ts`, Personenkonto, `webRequest`, `nativeImage`), Link-Monitor (`link-monitor/browser.ts`), Discovery-Rückfall (`discovery/profiler.ts:232`) | LinkedIn bleibt **außerhalb** des Containers (Personenkonto, Fingerprint; wie E5.3 im Enterprise-Plan), wahlweise über einen Node. Link-Monitor und Discovery-Rückfall auf Selenium/Chromium im Container umstellen oder `fetch` | mittel (Link-Monitor), LinkedIn = Stufe 3 |
| **Rückfragen an die Person** | `askChoice`/`askText`/`askMatch` warten auf den Renderer; autonom: Fehler oder `RemoteAskHandler` (Telegram) | Telegram-Weg existiert; Web-Client (Stufe 2) bringt den Renderer-Weg zurück. `askMatch` bleibt Desktop/Web | vorhanden |
| **Anhänge im Chat** | Renderer: SheetJS, pdf-to-images | laufen im Web-Client weiter (Browser-Code); für Telegram gibt es Main-seitige Extraktoren in `mail/attachments.ts` | klein |
| **Sprachmodus** | WebRTC im Renderer, Main erzeugt Sitzung | funktioniert im Web-Client unverändert (Browser-API) | keiner |

### 4.2 Was sich NICHT ändern muss

Orchestrator und alle rund 250 Werkzeuge, Workflows-Engine, Scheduler,
Heartbeat, Auffrischung, Telegram-Client, IMAP/SMTP, Gateway-Client,
Tenant-Policy, MCP-Endpunkt, die sechs Producer selbst (nur Umgebung), die
Register-Delta-CLI, der Gateway und das gesamte Substrat.

## 5. Zielbild

```
                 ┌──────────────── Rechner der Person ────────────────┐
                 │  AVA Desktop (Client)         AVA Node (optional)   │
                 │  Renderer wie heute           LinkedIn-Fenster,     │
                 │  Transport: WS statt IPC      Mikrofon, Logins      │
                 └──────────┬───────────────────────────┬─────────────┘
   Telegram ──┐             │ wss (Token/Pairing)        │ node.invoke
   MCP ───────┤             ▼                            ▼
              ▼   ┌──────────────── Container je Nutzer ───────────────┐
   ┌──────────┴─┐ │  AVA-Kopf (headless Main)                          │
   │ db-gateway │◄┼─ Orchestrator · Werkzeuge · Workflows · Scheduler  │
   │ Keycloak   │ │  Heartbeat · Telegram · Mail · Audit · Usage       │
   │ master-data│ │  /data: PGlite + JSON   CredentialStore (AES)      │
   │ CloudAMQP  │◄┼─ 6 Producer (node) + Chromium/chromedriver         │
   │ MPG · ES   │ │  Sidecar: Ollama (Embeddings; Chat nur mit GPU)    │
   └────────────┘ │  Reverse-Proxy (Caddy) · /healthz · /setup         │
                  └────────────────────────────────────────────────────┘
```

Drei Betriebsformen auf derselben Codebasis:

| Form | Kopf | Producer | Browser | Für wen |
|---|---|---|---|---|
| **Desktop** (heute) | lokal | lokal | Chrome for Testing lokal | alle |
| **Desktop + Producer-Container** (Stufe 0) | lokal | Container | Chromium im Container | schwache Laptops, Teams mit eigenem Server |
| **Cloud** (Stufe 1–3) | Container | Container | Chromium im Container, LinkedIn über Node | Self-Hosting, Enterprise, „läuft, wenn der Laptop zu ist“ |

## 6. Stufen

### Stufe 0: Producer-Container (≈ 5–8 Tage)

Ein Image `ava-producers` mit den sechs Producern, Chromium, chromedriver
und einem kleinen Supervisor. Der Kopf bleibt der Desktop.

- `services/producer-host/`: Dockerfile nach Vorbild `packages/register-delta`
  (Alpine, Chromium, nicht root), Multi-Stage mit den gebauten Producern aus
  dem Monorepo (dieselbe Liste wie `fetch-producers.mjs`).
- Supervisor-CLI: liest `GATEWAY_URL` und einen Refresh-Token (Device-Flow,
  §4.1), holt `/v1/local-credentials` und `/v1/local-amqp-url`, baut die
  Umgebung mit genau der `buildEnv`-Logik aus `producer-supervisor.ts`
  (herauslösen nach `packages/producer-env`), startet `node dist/web/api/
  server.js` je Producer, Health über die Probe-Ports.
- LLM: `LLM_PROVIDER`/Schlüssel aus Docker-Secrets, `OLLAMA_URL` auf den
  Sidecar für Embeddings. Loopback-Token-Server für das ChatGPT-Abo kann der
  Supervisor selbst stellen, wenn ein Abo-Token übergeben wird.
- Desktop: Schalter „Producer laufen auf einem Server“ je Konto. Dann startet
  die App ihre Producer nicht, zeigt aber den Verarbeitungsstand wie heute
  (kommt ohnehin über Gateway-SSE). Laufen beide, teilen sie sich die
  Warteschlange, das ist unschädlich.
- Compose-Datei `infra/docker-compose.producers.yml` mit Ollama-Sidecar.

Ergebnis: Importe, Auffrischung und Recherche-Aufträge (auch aus MCP) laufen
ohne laufende App. Noch nicht: Workflows, Heartbeat, Telegram, Mail.

### Stufe 1: AVA-Kopf headless (≈ 3–4 Wochen)

- **`bootstrapCore()` aus `index.ts` herauslösen.** Alles, was heute in
  `app.whenReady` komponiert wird (Orchestrator, Workflows, Mail, Telegram,
  Scheduler, Worker-Modus-Register, Hintergrundaufgaben), kommt in eine
  Funktion mit explizitem `CoreDeps`-Objekt. `index.ts` ruft sie mit den
  Electron-Implementierungen auf, `services/server/src/main.ts` mit den
  Server-Implementierungen. Keine Umbenennung, kein Paket-Umzug; das kann
  später kommen (`@ava/core` aus `PLANS_server_deployment.md`).
- **Vier Interfaces:** `Paths` (ersetzt `app.getPath`, 68 Dateien, rein
  mechanisch), `CredentialStore` (10 Stores), `Notifier` (7 Stellen),
  `ProcessSpawner` (Producer, Register-Delta, Wachhund). `BrowserWindow`-
  Nutzer bekommen ein `WindowBridge`, das im Server `null` liefert; der
  LinkedIn-Zeitplan überspringt dann wie heute ohne Fenster.
- **Anmeldung:** Device Authorization Grant in Keycloak (Realm-Konfig über
  `infra/scripts/keycloak-config.mjs`), Setup-Seite `/setup` im Container
  zeigt URL und Code.
- **Image `ava-server`:** Kopf + Producer in einem Image (ein Prozessbaum wie
  auf dem Desktop), Volume `/data`, `/healthz`, Caddy-Beispiel für TLS,
  Telegram-Allowlist als harte Sperre (heute ein gebundener Chat je Konto,
  fremde Chats werden verworfen, `telegram/inbound.ts:186`; im Server
  prüfen, dass ohne gebundenen Chat nichts angenommen wird).
- **Worker-Modus-Register wiederverwenden:** Dienste, die im Container keinen
  Sinn haben (LinkedIn, Erreichbarkeitsprüfung des Nutzer-Netzes), werden
  per `darfLaufen` ausgeschaltet statt ausgebaut.
- Telegram und MCP sind damit sofort vollwertige Clients; Workflows,
  Heartbeat, Auffrischung, Mail-Triage laufen rund um die Uhr.

### Stufe 2: Oberfläche als Web-Client (≈ 2–3 Wochen)

- Die 317 `ipcMain.handle` und 53 Push-Kanäle laufen durch eine Preload-
  Datei. Ein Transport-Interface (`invoke(channel, args)`,
  `on(channel, cb)`) mit zwei Implementierungen: Electron-IPC und WebSocket.
  Server-seitig ein Dispatcher, der die vorhandenen Handler-Funktionen
  unverändert aufruft (sie werden aus `ipcMain.handle(name, fn)` in eine
  Map `name → fn` registriert; Electron registriert daraus seine Handler).
- Der Kopf liefert das gebaute Renderer-Bundle über HTTP aus. Ergebnis ist
  ein „Browser-App“-Zugang wie OpenClaws Control UI, und der Desktop kann
  per Einstellung „mit Server verbinden“ denselben Weg nutzen.
- Auth am WebSocket: Keycloak-Access-Token des Clients; der Kopf prüft die
  Identität gegen sein eigenes Konto (ein Konto je Container).
- Renderer-Code, der Browser-APIs nutzt (SheetJS, pdfjs, WebRTC-Sprachmodus),
  läuft im Web-Client unverändert.

### Stufe 3: Node-Modus (später, ≈ 2 Wochen)

- Desktop meldet sich beim Kopf als Node an (`role: node`), muss im Kopf
  freigegeben werden, und bietet an: LinkedIn-Fenster (Zeitplan und
  Werkzeuge laufen dann über `node.invoke`), Mikrofon, interaktive Logins
  (Sign in with ChatGPT, CRM-OAuth) mit Token-Übergabe an den
  CredentialStore des Kopfs.
- Optional der lokale Chrome als Browser für Producer-Jobs, wenn die
  Scraping-Herkunft (§7) eine Wohnort-IP verlangt.

## 7. Risiken und offene Fragen

1. **Scraping-Herkunft.** Register-Portal: eine IP = 60 Abfragen je Stunde
   (bekannt vom Fly-Worker). Google-Suche läuft über valueserp, nicht über
   den Browser; Firmen-Websites, Stellenportale und Register aus
   Rechenzentrums-IPs werden häufiger geblockt oder mit CAPTCHAs belegt.
   Gegenmittel: Stufe 3 (Browser auf dem Node), oder ein Proxy-Anbieter als
   Kundenkonfiguration. Vor Stufe 0 mit zehn Firmen aus einem Hetzner-/Fly-
   Container messen.
2. **Compute-Lokalität und Schlüssel.** `DECISIONS.md` sagt „Gerät des
   Nutzers“. Vorschlag für die Notiz: „Hoheit des Nutzers: eigenes Gerät
   oder ein Container, den der Nutzer selbst betreibt oder der ihm exklusiv
   zugeordnet ist und in den nur er seine Schlüssel einbringt.“ Der
   Betreiber hostet **keinen** gemeinsamen Kopf für alle (Option A aus
   PLAN_WORKFLOWS_OHNE_APP bleibt verworfen). Hostet der Betreiber
   dedizierte Container für Kunden, braucht das AVV-Text und Preis.
3. **Lokale Modelle in der Cloud.** Ohne GPU keine Chat-Qualität. Preise
   (Stand Recherche, Drittquellen, vor Bestellung prüfen):

   | Option | Monat |
   |---|---|
   | Fly `shared-cpu-2x`, 4 GB (OpenClaw-Blueprint, Kopf + Producer knapp) | ≈ 20–25 $ |
   | Hetzner GEX45, 24 GB VRAM (reicht für qwen3:8b) | ≈ 214 € + Einrichtung |
   | Hetzner GEX131, 96 GB VRAM | ≈ 1.200 € |
   | Fly GPUs | eingestellt |

   Für den Cloud-Modus ist der eigene Schlüssel oder das ChatGPT-Abo der
   realistische Standard; Ollama bleibt für Embeddings.
4. **Speicher.** Kopf (~500 MB), sechs Producer (je 150–300 MB), parallel
   laufende Chromium-Instanzen (je ~300 MB), PGlite. Empfehlung 8 GB RAM,
   4 vCPU; 4 GB geht mit Producer-Parallelität 1.
5. **PGlite im Container.** Ein Volume reicht für einen Nutzer. Mehrere Nutzer
   in einem Kopf sind nicht Ziel (siehe 2). `close()` blockiert die
   Event-Loop (bekannt): beim Container-Stop `suspend*` statt `close()`.
6. **Zwei Stores bei zwei Köpfen.** Läuft der Desktop weiter als eigener
   Kopf und zusätzlich der Container, gibt es zwei Chat-Verläufe, zwei
   Workflow-Stores. Entscheidung aus PLAN_WORKFLOWS_OHNE_APP §5.3 gilt: der
   Server ist Master; der Desktop verbindet sich (Stufe 2) statt parallel zu
   laufen. Übergang: Export/Import des `/data`-Ordners aus dem Desktop.
7. **LinkedIn-Modul** bleibt draußen oder auf dem Node. Im Cloud-Modus
   standardmäßig aus (Org-Feature), ehrlich in der Oberfläche.
8. **Netz-Härtung.** Container bindet nur loopback, Caddy davor; Chromium im
   Container darf keine privaten Netzbereiche erreichen (Docker-Netz ohne
   Zugang zum Host-Netz, Allowlist im Browser-Lebenszyklus); Download-Sperre
   wie heute per Chrome-Pref; Telegram-Allowlist hart.
9. **Marketing.** Keine Aussage auf der Website vor Stufe 1 live. Formulierung
   dann: „AVA läuft auf deinem Rechner oder auf deinem Server.“

## 8. Entscheidungen, die der Operator treffen muss

1. Stufe 0 zuerst (schnell, sichtbar) oder direkt Stufe 1?
   Vorschlag: Stufe 0, weil sie die Producer-Umgebung entkoppelt, die
   Stufe 1 ohnehin braucht, und sofort einen messbaren Nutzen hat.
2. Keycloak Device-Flow am bestehenden Client `ava-desktop` oder eigener
   Client `ava-server`? Vorschlag: eigener Client, damit Server-Sitzungen
   im Audit unterscheidbar sind.
3. Bietet der Betreiber dedizierte Container an (Preis, AVV) oder nur
   Self-Hosting-Doku? Vorschlag: zuerst Self-Hosting mit Compose-Datei;
   dedizierte Container erst, wenn ein Enterprise-Kunde es verlangt (E5).
4. Compute-Lokalitäts-Notiz in `DECISIONS.md` wie in §7.2 umformulieren?

## 9. Nebenbefunde

- `company-contact/Dockerfile` setzt einen GitLab-npm-Token als `ENV` im
  Klartext. Das Repository ist seit 2026-09-19 öffentlich. Token widerrufen
  und auf `--build-secret` umstellen wie in `master-data/Dockerfile` und
  `services/db-gateway/Dockerfile`.
- Die Producer-Dockerfiles und `fly.toml`-Dateien sind Vorlagen aus der
  Fly-Zeit (node:21). Stufe 0 ersetzt sie durch ein gemeinsames Image;
  danach löschen oder als Verweis stehen lassen.
- `PLAN_ENTERPRISE_FREIGABE.md` E5.1 nennt „Dockerfiles für die vier
  Producer, die heute nur im Desktop vendored sind“; tatsächlich haben alle
  sechs ein Dockerfile, nur veraltet.

## 10. Quellen

- OpenClaw-Doku: Docker (`docs.openclaw.ai/install/docker`), Remote-Gateway
  (`docs.openclaw.ai/gateway/remote`), Nodes (`docs.openclaw.ai/nodes`),
  Browser (`docs.openclaw.ai/browser`, `docs2.openclaw.ai/tools/browser/remote`),
  Sicherheit (`docs.openclaw.ai/gateway/security`).
- Fly-Blueprint „Deploy OpenClaw“ (`docs.fly.io/blueprints/deploy-openclaw`).
- Release 2.0 / v2026.8.1: Wikipedia „OpenClaw“, the-decoder.com,
  implicator.ai („multiplayer, not a security boundary“), helpnetsecurity.com.
- Preise: Hetzner GEX-Reihe (datacentrenews.uk, whtop.com), Fly-Preisseite
  (GPUs eingestellt).
- Intern: `docs/PLANS_server_deployment.md`, `docs/PLAN_WORKFLOWS_OHNE_APP.md`,
  `docs/PLAN_ENTERPRISE_FREIGABE.md` (E5), `docs/PLAN_MCP_OEFFNUNG.md`,
  `docs/PLAN_WORKER_MODUS.md`, `docs/DECISIONS.md`, Inventar des
  Hauptprozesses vom 2026-10-09 (§4).

## 11. Variante „ohne App“: Claude oder ChatGPT steuert AVA vollständig über MCP (2026-10-09, zweite Runde)

Idee des Operators: Im Cloud-Modus gibt es weder App noch Web-Client. Ein
zweiter MCP-Server hält alle Werkzeuge vor, die der App-Chat hat; Claude oder
ChatGPT übernimmt die Rolle des Chat-Fensters.

### 11.1 Urteil

Ja, das trägt, und es ist billiger als Stufe 2. Begründung aus dem Code:

- Alle 283 Werkzeuge liegen in einer `ToolRegistry` und tragen bereits ein
  handgeschriebenes JSON-Schema plus yup-Prüfung (`agent/define-tool.ts`).
  Ein MCP-Werkzeug ist genau das: Name, JSON-Schema, Handler. Die Fassade
  ist eine Schleife über die Registry.
- AVA löst das Mengenproblem schon selbst: seit v0.1.240 sieht ein Gespräch
  nur die Kern-Werkzeuge und lädt den Rest über `tool_search`/`tool_load`
  nach (`agent/tool-selection.ts`). Dasselbe Muster gilt für MCP, denn kein
  Client verträgt 283 Schemas im Kontext.
- Freigaben sind je Kanal geregelt: `confirmAction` mit Vollmacht-Stufe,
  destruktive Klasse wird nie autonom bestätigt (`agent/ui-bridge.ts:92`).
  MCP wird ein weiterer Kanal mit eigener Vollmacht-Stufe.

Was die Variante **nicht** einspart: Stufe 1. Die Werkzeuge sind keine
freistehenden Funktionen, sie brauchen Stores, Gateway-Client, Provider,
Producer-Supervisor und Workflow-Engine. Der headless Kopf bleibt die
Voraussetzung; weg fällt nur der Renderer.

### 11.2 Zwei Wege, den zweiten MCP zu erreichen

| | A: MCP direkt im Container | B: Relais über den Gateway (empfohlen) |
|---|---|---|
| Adresse | je Container eine öffentliche HTTPS-Adresse, Caddy, Domain oder Tunnel | eine Adresse `mcp.ava.bi` wie heute; der Gateway leitet an den Kopf des angemeldeten Nutzers weiter |
| Verbindung | eingehend in den Container | der Kopf verbindet sich **ausgehend** per WebSocket zum Gateway und meldet seine Werkzeugliste an (das Node-Muster von OpenClaw, nur umgekehrt) |
| Funktioniert mit dem Desktop als Kopf | nein | **ja, sofort**: Claude steuert die laufende Desktop-App, noch bevor es einen Container gibt |
| Datenweg | Claude ↔ Container | Claude ↔ Gateway ↔ Kopf; der Gateway speichert nichts, reicht nur durch (Audit-Zeile mit Werkzeugname, ohne Argumente) |
| Aufwand | Caddy, Zertifikate, Doku je Nutzer | Gateway-Route + Kopf-Client, einmal |

Weg B ist der Grund, warum die Variante „ohne alles umzuwerfen“ geht: Der
heutige Gateway-MCP (neun Werkzeuge auf Gateway-Daten) bleibt als Grundmenge,
die auch ohne laufenden Kopf antwortet. Ist der Kopf online, ergänzt der
Gateway dessen Werkzeugliste (`tools/list` liefert beides, `tools/call`
leitet weiter, `notifications/tools/list_changed` beim Verbinden). Ein MCP-
Server, zwei Quellen. Der Nutzer merkt nur: „AVA läuft gerade nicht“, wenn
der Kopf fehlt.

### 11.3 Wer ist das Gehirn?

Mit rohen Werkzeugen ist Claude der Orchestrator. AVAs eigene Schicht
(Soul, Gedächtnis über Gespräche, Nutzerprofil, Kontext-Kürzung,
Datei-Handles, Ergebnis-Obergrenzen, Vorschlags-Chips, Turn-Urteil) wird
umgangen. Drei Bausteine holen das Wesentliche zurück:

1. **`instructions` im MCP-Handshake** tragen die Kurzfassung von Soul und
   Regeln (Du-Form, Personendaten sparsam, erst lesen, dann schreiben).
2. **Gedächtnis und Profil als Werkzeuge**, die es schon gibt, bleiben in der
   Kernmenge, damit Claude sie nutzt wie AVAs Modell.
3. **`ava_fragen` als ein Werkzeug**, das den kompletten AVA-Orchestrator
   mit eigenem Modell laufen lässt (Agent als Werkzeug). Für Nutzer, die
   „genau den App-Chat“ wollen. Kostet doppelt (Claude plus AVA-Modell), ist
   aber die ehrliche Antwort auf „dasselbe wie im App-Chat“.

Standard: rohe Werkzeuge mit Kernmenge und Suche. Vorteil nebenbei: Der
Chat läuft auf dem Claude- oder ChatGPT-Abo des Nutzers, AVA braucht für den
Chat keinen eigenen Schlüssel mehr. Die Producer brauchen ihn weiter.

### 11.4 Was verloren geht und was es ersetzt

| App-Funktion | Über MCP |
|---|---|
| Firmenansichten, Buying-Center-Karte, Verflechtungen-Graph, Charts | Text und Tabellen; Claude-Artefakte können Charts rendern. **MCP Apps** (Protokoll-Erweiterung, von Anthropic und OpenAI getragen) erlaubt Oberflächen aus dem MCP-Server heraus; Stand der Client-Unterstützung vor Nutzung prüfen |
| Workflow-Editor | Werkzeuge `workflow_*` existieren; Editor entfällt, Definition als Text |
| Rückfragen `askChoice`/`askText` | Zwei-Schritt-Werkzeug: erste Antwort „Rückfrage: …“, zweiter Aufruf mit Antwort. MCP-Elicitation, sobald Claude.ai und ChatGPT sie verlässlich können |
| Freigabe schreibender Aktionen | Zwei-Schritt mit Freigabe-Token aus `confirmAction`; der Mensch sitzt im Claude-Chat, aber der Server erzwingt den zweiten Schritt, damit eine Prompt-Injection in gelesenen Inhalten nicht durchschreibt. Destruktiv (`mail_send`, CRM-Löschen) nie ohne |
| Dateien hinein | Base64 in Argumenten (heute 5 MB beim Import); größere über Upload-Adresse am Gateway |
| Dateien heraus | MCP-Resources oder signierte Gateway-Links |
| Lange Läufe | wie beschlossen: Auftrag anlegen, Status abfragen, Rückmeldung über Telegram/Mail. MCP-Aufrufe haben Zeitlimits im Client |
| Proaktives (Heartbeat, Alarme, Workflows) | läuft im Kopf weiter; Ausgabe über Telegram/Mail; Claude liest `meldungen` beim nächsten Gespräch |
| Erst-Einrichtung (Schlüssel, Erst-Consent, Keycloak-Login) | bleibt eine kleine `/setup`-Seite im Container oder eine CLI; laut Regel kein Self-Service über den Chat |
| Sprachmodus, LinkedIn-Fenster, Mikrofon | nicht ohne Gerät; Stufe 3 (Node) |

### 11.5 Schritte

| Schritt | Inhalt | Aufwand |
|---|---|---|
| X1 | Kopf-seitiger WebSocket-Client zum Gateway: anmelden, Werkzeugliste (Name, Schema, Hinweise lesend/schreibend/destruktiv) übertragen, `call` entgegennehmen, Ergebnis zurück. Kanal `mcp` mit Vollmacht-Stufe und Zwei-Schritt-Freigabe | 4–5 Tage |
| X2 | Gateway: Route für Kopf-Verbindungen je Nutzer, `/mcp` vereint eigene und Kopf-Werkzeuge, Weiterleitung mit Zeitlimit, Org-Schalter je Werkzeug wie heute, Audit ohne Argumente | 3–4 Tage |
| X3 | Kernmenge für MCP (≈ 25 Werkzeuge: `company_get`, Suche, Meldungen, Import, Recherche, Gedächtnis, Profil, `tool_search`/`tool_load` als MCP-Werkzeuge), `instructions`-Text, Test mit Claude.ai, Claude Code und ChatGPT-Entwicklermodus | 2–3 Tage |
| X4 | Stufe 1 aus §6 (Kopf headless im Container), **ohne** Stufe 2 | 3–4 Wochen |
| X5 | optional `ava_fragen` (Agent als Werkzeug), MCP Apps für zwei Ansichten (Firma, Buying Center) | später |

X1–X3 sind unabhängig vom Container und sofort mit der Desktop-App nutzbar.
Das ist der empfohlene Einstieg: Er beweist die Steuerung über Claude, bevor
Geld in den Container fließt, und wird später vom Container ohne Änderung
übernommen.

### 11.6 Offen

1. Rohe Werkzeuge als Standard, `ava_fragen` als Zusatz? (Vorschlag: ja.)
2. Zwei-Schritt-Freigabe für jede schreibende Aktion, oder Vollmacht-Stufe
   des Kanals `mcp` wie bei Telegram? (Vorschlag: Vollmacht gilt, destruktiv
   immer zwei Schritte.)
3. Darf der Gateway Werkzeug-Argumente im Audit speichern? (Vorschlag: nur
   Name, Dauer, Ergebnisgröße.)
4. ChatGPT: Schreibende Werkzeuge nur im Entwicklermodus der Connectors;
   reicht das für die Zielgruppe?

## 12. Zielbild präzisiert: dieselbe AVA auf dem Server, nur ohne Oberfläche (2026-10-09, dritte Runde)

Vorgabe des Operators: nicht abgespeckt. Auf dem Server läuft die komplette
AVA wie in der App (Orchestrator, alle Werkzeuge, Workflows, Heartbeat,
Producer, Telegram, Mail), nur ohne Fenster. Claude oder ChatGPT sind über
MCP das, was heute der App-Chat ist. Frage: geht das mit dem heutigen Stand
fast von selbst, oder ist alles in Electron verdrahtet? Und falls ja: ist
die Aufgabe dann ein Refactoring, damit Electron-App und Server dieselbe
Codebasis teilen?

### 12.1 Befund: nicht in der Logik hardcodiert, aber in der Verdrahtung

Messung in `services/desktop/src/main` (274 Dateien):

| | Zahl | Bedeutung |
|---|---|---|
| Module mit `electron`-Import außer index.ts | 87 | davon 72 nur `app` (fast immer `app.getPath`) |
| davon `BrowserWindow` | 17 + 4 Typ-Importe | Login-Fenster, LinkedIn, Link-Monitor, Audio-Decoder, Discovery-Rückfall |
| davon `safeStorage` | 9 Module (10 Stores) | Geheimnisse |
| davon `Notification`, `shell`, `net`, `session`, `protocol`, `powerMonitor` | je 1–5 | Randfunktionen |
| `index.ts` | 7.962 Zeilen, 317 IPC-Handler, gesamte Komposition in `app.whenReady` | **das eigentliche Hindernis** |
| IPC-Handler mit Logik im Body (> 15 Zeilen) | ≈ 50 | müssen in Module wandern, sonst fehlt die Logik dem Server |

Die Dienste selbst (Orchestrator mit streamChat, ToolRegistry, Workflows,
Scheduler, Heartbeat, Auffrischung, Telegram-Client, IMAP/SMTP, Status-
Wächter, Producer-Supervisor bis auf den Spawn) importieren kein Electron.
Der Test-Stub `scripts/_electron-stub.mjs` zeigt, dass Stores und Workflows
heute schon ohne Electron laden, wenn `app` und `safeStorage` gestubbt sind.

Antwort auf die Frage: **Es geht nicht „einfach so“, weil es keinen Einstieg
ohne `app.whenReady` gibt.** Aber es ist auch kein Neubau. Es ist ein
mechanisches Refactoring mit bekannter Größe, das die Desktop-App unverändert
lässt und sich in normalen Releases ausliefern lässt.

### 12.2 Architekturregel (neu): eine Codebasis, zwei Einstiege

```
services/desktop/src/
  core/            ← alles, was heute unter main/ liegt, ohne Electron-Import
    bootstrap.ts   ← bootstrapCore(platform, config) → Core
    platform.ts    ← Interfaces: Paths, CredentialStore, Notifier,
                     ProcessSpawner, WindowBridge, Power, Opener
  main/            ← Electron-Einstieg: platform-electron/*, Fenster, IPC
    index.ts       ← wird dünn: Plattform bauen → bootstrapCore → Fenster → IPC
    ipc/*.ts       ← die 317 Handler, nach Domäne, jeder bekommt `core`
  server/          ← Node-Einstieg: platform-node/*, Device-Flow-Login,
    main.ts          Telegram, MCP-Relais-Client, /healthz, /setup
```

Kein Paket-Umzug nötig (das `@ava/core`-Paket aus `PLANS_server_deployment.md`
kann später folgen). Entscheidend ist die Regel, die ab dann gilt und per
ESLint `no-restricted-imports` erzwungen wird: **unter `core/` wird `electron`
nicht importiert.** Alles, was die Plattform liefert, kommt über die
Interfaces.

Der Server ist dann wörtlich dieselbe AVA: gleiche Registry, gleicher
Orchestrator für Hintergrund-KI, Telegram und Mail-Triage, gleiche Workflows,
gleiche Producer. Zwei Vordertüren statt einer Oberfläche: Telegram (AVAs
eigenes Modell) und MCP (Claude oder ChatGPT als Gehirn, AVAs Werkzeuge; §11).

### 12.3 Refactoring-Schritte

| Schritt | Inhalt | Aufwand | Risiko |
|---|---|---|---|
| **R1 Plattform-Schicht** | `core/platform.ts` mit Interfaces; Electron-Implementierung; alle 72 `app.getPath`-Stellen auf `paths.*`, 10 Stores auf `credentialStore`, 7 `Notification` auf `notifier`, 3 Spawns auf `spawner`, 17 `BrowserWindow`-Nutzer auf `windowBridge` (liefert im Server `null`, Aufrufer behandeln das wie heute „kein Fenster“). ESLint-Regel scharf. | 5–7 Tage | gering, kein Verhaltenswechsel, Desktop-Release wie gewohnt |
| **R2 bootstrapCore** | Komposition aus `app.whenReady` nach `core/bootstrap.ts`; Rückgabe eines `Core`-Objekts (Registry, Orchestrator, Dienste, Worker-Modus-Register, Hintergrundaufgaben). IPC-Handler domänenweise nach `main/ipc/`; die ≈ 50 Handler mit Logik im Body geben die Logik an das zuständige Modul ab (häufig existiert dort schon ein Werkzeug, dann ruft der Handler dasselbe wie das Werkzeug). Pro Domäne ein Release. | 2–3 Wochen | mittel, weil index.ts die Startreihenfolge kodiert (Postgres-Freigabe, Auth-Broadcast, Worker-Modus nach 5 s); Reihenfolge als Liste in bootstrap.ts festschreiben und mit `test:neustart-grenze`-artigen Skripten sichern |
| **R3 Server-Einstieg** | `server/main.ts`: Node-Plattform (XDG-Pfade bzw. `AVA_DATA_DIR`, AES-Datei für Geheimnisse, Telegram als Notifier, `node` als Spawner), Konfiguration aus Env, Keycloak Device Flow, `/healthz`, `/setup`; zweites Build-Ziel (Vite-Entry oder tsup); Dockerfile mit Producern + Chromium + ffmpeg; Compose mit Ollama-Sidecar. Smoke-Test in CI: Server-Einstieg gegen `scripts/mock-gateway.mjs` hochfahren, Werkzeugliste abfragen. | 1–2 Wochen | gering |
| **R4 Fensterlose Ersatzwege** | OGG→WAV per ffmpeg statt WebAudio-Fenster; Link-Monitor und Discovery-Rückfall auf Selenium/Chromium oder `fetch`; LinkedIn, Mikrofon, Sign-in-with-ChatGPT-Fenster per `darfLaufen` im Server aus (später Node, Stufe 3). | 4–6 Tage | gering |
| **X1–X3 MCP-Relais** (§11.5) | unabhängig von R1–R4, läuft sofort mit dem Desktop als Kopf | ≈ 2 Wochen | gering |

Summe Refactoring R1–R4: **5–7 Wochen**, in Teilen parallel zum normalen
Betrieb, weil jeder Schritt für sich auslieferbar ist. Mit X1–X3 davor oder
parallel ist der erste Server, den Claude vollständig steuert, in etwa zwei
Monaten realistisch.

### 12.4 Reihenfolge-Empfehlung

1. **X1–X3 zuerst** (zwei Wochen): Claude steuert die laufende Desktop-App
   über mcp.ava.bi. Das beweist die Bedienung ohne Oberfläche an der echten
   Werkzeugmenge, bevor irgendetwas umgebaut wird, und deckt auf, welche
   Werkzeuge noch Renderer-Rückfragen voraussetzen.
2. **R1** in einem Release, **R2** domänenweise über mehrere Releases.
3. **R3 + R4** zusammen, erster Container beim Operator, dann Self-Hosting-
   Doku.
4. Danach entscheiden: Stufe 0 (Producer-Container ohne Kopf) wird durch R3
   überflüssig, Stufe 2 (Web-Client) ist optional, Stufe 3 (Node) bleibt.

### 12.5 Was der Operator jetzt entscheidet

1. Reihenfolge wie 12.4, oder R1/R2 zuerst und MCP danach?
2. ESLint-Regel „kein electron unter core/“ ab R1 verbindlich (blockt Builds)?
3. Verzeichnisname `core/` innerhalb von `services/desktop/src`, oder gleich
   ein Workspace-Paket `packages/core`? Vorschlag: zuerst Verzeichnis, Paket
   später, damit R1/R2 keine Build-Umstellung mitschleppen.

### 12.6 Stand R1 (v0.1.787, 2026-10-09)

Umgesetzt:

- `src/core/platform.ts`: Schnittstellen `Paths`, `CredentialStore`,
  `Notifier`, `Opener`, `ProcessSpawner`, `WindowBridge`, `Power`,
  `Lifecycle`; Zugriff über `paths()`, `credentials()`, … Ohne gesetzte
  Plattform gilt die Node-Fassung.
- `src/core/platform-node.ts`: Node-Umsetzung für Server und Tests.
  `AVA_DATA_DIR` (Konto-Space), `AVA_RESOURCES_DIR` (Ressourcen, setzt
  „paketiert“), `AVA_SECRETS_KEY` (32 Byte, AES-256-GCM; ohne Schlüssel gilt
  „Schlüsselbund nicht verfügbar“), `AVA_VERSION`.
- `src/main/platform-electron.ts`: Electron-Umsetzung, erster Import in
  `index.ts`. `focusMain` bevorzugt das Hauptfenster (`__avaMainWindow`) statt
  `wins[0]`, das seit v0.1.330 das unsichtbare LinkedIn-Fenster sein kann.
- 70 Module per Codemod umgestellt (`app.getPath` → `paths().get`,
  `safeStorage` → `credentials()`, `shell` → `opener()`, `app.relaunch/exit` →
  `lifecycle()`), dazu von Hand: die drei Spawns (Producer, Wachhund,
  Register-Delta) über `spawner().nodeCommand()`, `process.resourcesPath` →
  `paths().resources()`, Benachrichtigungen in notifications.ts, organisation.ts
  und ui-bridge.ts über `notifier()`, Fenster-Broadcasts in org-policy.ts,
  organisation.ts, billing.ts, auth.ts, crm/oauth-flow.ts, linkedin/scheduler.ts
  über `windows()`, `powerMonitor` über `power()`, Skills-Loader nimmt `Paths`
  statt `App`.
- Wächter `scripts/check-electron-imports.mjs` in `build:typecheck`: unter
  `src/core/` nie `electron`; unter `src/main/` nur die 23 benannten Ausnahmen
  (mit Grund und ablösendem Schritt). Fehlende oder überflüssige Einträge
  brechen den Build.
- Test-Stub `_electron-stub.mjs` setzt `AVA_DATA_DIR` und einen Testschlüssel.

Geprüft: `tsc` beider Projekte grün, `electron-vite build` grün, 17 der 23
Test-Skripte grün. Die sechs `test:skills*`-Skripte scheitern schon vor R1
(tsx/Node-24-Interop, „does not provide an export named“) und sind nicht
Teil dieses Schritts. `check-german` meldet zwei englische ChatGPT-Texte aus
v0.1.761, ebenfalls vorbestehend. Kein Live-Start der App in dieser Session
(hätte die laufende AVA über die Producer-Ports beendet).

Verbleibende 23 Ausnahmen nach Schritt: R2 (index.ts, account-space,
file-logger, billing, producer-screenshots), R4 (auth-Fenster, Link-Monitor,
Discovery-Rückfall, telegram/audio), Stufe 3 (LinkedIn-Modul, siwc-oauth,
agent/tools/linkedin), dauerhaft Electron (platform-electron, updater,
download-guard, externe-links).

### 12.7 Stand R2a: IPC-Handler nach Domänen (v0.1.788, 2026-10-09)

Alle 287 `ipcMain.handle`/`ipcMain.on`-Blöcke aus `index.ts` liegen jetzt in
20 Dateien unter `src/main/ipc/`, je Domäne eine Funktion
`register<Domäne>Ipc(deps)` mit explizitem Deps-Interface. Die Handler-Bodies
sind unverändert; `index.ts` ruft die Register-Funktionen an der Stelle des
jeweils letzten ehemaligen Handlers auf (alle vor `createMainWindow()`), so
dass jede Abhängigkeit dort schon existiert. `index.ts` schrumpft von 7.962
auf 5.113 Zeilen.

Muster für spät gesetzte Dienste (vormals `let` in index.ts): statt Getter ein
Halter `{ readonly current: T | null }`, in index.ts als
`{ get current() { return x; } }` übergeben. Grund: TypeScript verengt
`x.current` nach einem Null-Check weiter, einen Getter-Aufruf `x()` nicht.
Schreibende Fälle (`icpAnalysisRunning`) bekommen zusätzlich einen Setter.

`src/main/ipc/` ist die Electron-Adapter-Schicht und darf `electron`
importieren; der Wächter nimmt das Verzeichnis pauschal aus. Geprüft:
Typecheck, Build, 17 Test-Skripte, Abgleich aller Preload-Kanäle gegen die
Handler (316 Kanäle, 287 Handler hier, Rest in billing.ts und linkedin/).

Dateien: agent, skills, recherche, sprache, discovery, personen, system,
laufzeit, konto, vorschlaege, stammdaten, crm, meldungen, verlauf,
kommunikation, beobachtung, stimme, wissen, ablaeufe, relevanz.

Noch in index.ts: die Komposition (Stores, Supervisoren, Orchestrator) auf
Modulebene und in `app.whenReady`, die `broadcast*`-Helfer, Auth-/Updater-/
Producer-Verdrahtung, Beenden-Kette. Das ist R2b (`bootstrapCore`).

### 12.8 Stand R2b: `bootstrapCore` (v0.1.789, 2026-10-09)

Die Komposition liegt jetzt in `src/core/bootstrap.ts`:
`bootstrapCore(hooks)` baut alles (Stores, Supervisoren, Orchestrator,
Workflows, Telegram, Mail, Producer-Registry), verdrahtet es in der bisherigen
Reihenfolge, versucht die stille Anmeldung und liefert ein `Core`-Objekt mit
69 Konstanten und 18 Haltern (spät gesetzte Dienste) plus
`startBackground()` (Ollama, Postgres, Producer, Herzschlag, Frische,
Whisper, Worker-Modus). Der Typ `Core` ist `Awaited<ReturnType<typeof
bootstrapCore>>`, kein handgeschriebenes Interface. Die Datei importiert kein
Electron; der Wächter prüft das.

`src/main/index.ts` ist die Hülle (rund 560 Zeilen statt 7.962 zu Beginn
des Tages): Plattform setzen, Beenden-Anzeige, privilegierte Schemata,
Fenster, `bootstrapCore({ onResume })`, Protokoll-Handler, Sitzungs-
Berechtigungen und Download-Sperre, Billing-Protokoll, LinkedIn-Modul,
Wachhund, IPC-Registrierung, `createMainWindow()`, `startBackground()`,
Updater, Dock-Aktivierung, Beenden-Kette.

Was sich an der Reihenfolge geändert hat, bewusst und geprüft:

- Die Modulebene (vormals beim Laden von index.ts) läuft jetzt innerhalb von
  `app.whenReady`. Der Boot-Reset bleibt die erste Anweisung vor allen
  Stores.
- Sitzungs-Berechtigungen, Billing und LinkedIn-Init laufen nach der
  Komposition statt mittendrin; alles davon liegt weiter vor dem ersten
  Fenster. Die Protokoll-Handler ebenfalls.
- Die IPC-Registrierung liegt nach der stillen Anmeldung statt davor; der
  Renderer existiert zu beiden Zeitpunkten noch nicht.
- Der Fenster-Weckruf nach dem Aufwachen (Invalidate, `power:resumed`,
  Force-Reload ohne Ack) ist der Hook `onResume`, den die Hülle stellt; der
  Kopf ruft ihn an derselben Stelle wie bisher, nach dem Wiederanlauf der
  Dienste.

Geprüft: Typecheck, Build, Wächter, 17 Test-Skripte. Kein Live-Start in
dieser Session (siehe 12.6). Was beim ersten Start von v0.1.789 zu beachten
ist: Startsequenz bis zum Fenster, Dock-Klick, Schlafen/Aufwachen,
Beenden-Kette (Breadcrumbs im Log tragen jetzt dieselben Namen wie zuvor).

Damit steht die Voraussetzung für R3: `src/server/main.ts` ruft dieselbe
`bootstrapCore()` mit der Node-Plattform auf, registriert statt IPC den
Telegram-Eingang (läuft bereits im Kopf) und später den MCP-Relais-Client,
und ruft `startBackground()`.

### 12.9 Stand R3: Server-Einstieg (v0.1.790, 2026-10-09)

Dieselbe Komposition läuft unter Node. Rauchtest auf dem Mac mit leerem
Datenverzeichnis: Postgres (PGlite) bereit, sechs Producer registriert,
Telegram-Eingang und Hintergrunddienste gestartet, Health-Endpunkte antworten,
SIGTERM beendet sauber über dieselben Stopp-Schritte wie die App. Die
Anmeldung bricht noch mit `unauthorized_client` ab, weil der Device Flow am
Keycloak-Client nicht eingeschaltet ist (siehe „Einrichtung“).

Neu:

- `src/server/main.ts`: Node-Einstieg. `bootstrapCore({})`, `startBackground()`,
  Anmeldung per OAuth 2.0 Device Flow in Schleife (Code im Log und auf
  `GET /setup`), `GET /healthz` (Prozess lebt), `GET /readyz` (angemeldet und
  gestartet), `GET /status` (Kurzlage), SIGTERM/SIGINT mit Stopp-Kette.
- `src/server/stubs/electron.ts` und `electron-updater.ts`: Attrappen, auf die
  der Bundler (`scripts/build-server.mjs`, esbuild, `pnpm build:server`) die
  Importe umlenkt. Module unter src/main, die noch `electron` importieren,
  laden damit; was ein Fenster bräuchte, wirft mit klarer Meldung.
- `Auth.deviceFlowSignIn()` in `auth.ts`; `DiscoveryDoc` kennt
  `device_authorization_endpoint`.
- `ChromeForTesting` nimmt `AVA_CHROME_BIN` (+ `AVA_CHROMEDRIVER_DIR`) als festen
  Browser statt zu laden; `OllamaSupervisor` nimmt `AVA_OLLAMA_HOST/PORT` und
  übernimmt den Sidecar. Konto-Spaces (Wechsel per Neustart) nur unter Electron;
  `getSharedDir` nutzt die Plattform-Pfade.
- `Dockerfile.server` (Debian slim, Chromium, chromedriver, ffmpeg, tini, nicht
  root, Volume `/data`, Healthcheck), `.dockerignore`,
  `infra/docker-compose.server.yml` (AVA + Ollama-Sidecar, `shm_size` 1 GB,
  Port nur lokal), `infra/.env.server.example`.
- Wächter prüft auch `src/server/` (kein `electron`).

Einrichtung durch den Operator (einmalig):

1. Keycloak: am Client `ava-desktop` den OAuth 2.0 Device Authorization Grant
   einschalten. `infra/scripts/keycloak-config.mjs` setzt das Attribut
   `oauth2.device.authorization.grant.enabled` jetzt mit; alternativ im
   Admin-Portal unter Clients → ava-desktop → Capability config.
2. Image bauen: `docker build -f services/desktop/Dockerfile.server
   --secret id=npm_token,env=NPM_TOKEN -t ava-server .` (Token nur fürs
   Vendoring der Producer).
3. `infra/.env.server` aus dem Beispiel anlegen (`AVA_SECRETS_KEY` mit
   `openssl rand -hex 32`), `docker compose -f infra/docker-compose.server.yml up -d`,
   Anmelde-Code aus `logs -f ava` oder `http://127.0.0.1:8080/setup`.

Offen nach R3 (= R4 und Live-Test):

- Telegram-Sprachnachrichten: OGG→WAV läuft noch über das WebAudio-Fenster
  (`telegram/audio.ts`) und wirft im Server; ffmpeg ist im Image, der Umbau
  steht aus. Link-Monitor und Discovery-Rückfall (verstecktes Fenster)
  ebenso.
- Lokale Modelle: ohne GPU-Host bleibt Ollama im Container den Embeddings
  vorbehalten; Chat und Producer brauchen Schlüssel oder Abo.
- Erst-Einrichtung von Schlüsseln ohne Oberfläche: heute nur über Telegram
  (Chat-Werkzeuge) oder Umgebungsvariablen; eine kleine `/setup`-Maske für
  Schlüssel fehlt.
- `MaxListenersExceededWarning` für `keyChanged` am ProviderConfigStore
  (11 Listener) im Server-Log; prüfen, ob die App dasselbe meldet.

Docker-Build (fünf Anläufe, alle Lehren im Dockerfile kommentiert):

1. `pnpm install` über den ganzen Workspace scheitert, weil
   `packages/queue-client` beim `prepare` `@ava/event` aus der privaten
   Registry braucht. Lösung wie in der Release-Pipeline: nur
   `--filter "@ava/desktop..."`.
2. pnpm führt die `prepare`-Skripte trotz Filter für alle Workspace-Pakete aus.
   Lösung: `--ignore-scripts` und `@ava/ai-provider` gezielt bauen.
3. `.dockerignore` mit `**/dist` warf die eingecheckten Vendor-Kopien
   `vendor/ai-provider/dist` der Producer aus dem Kontext; ihr Build scheiterte.
   Lösung: nur `services/desktop/out|dist` und `packages/*/dist` ausschließen.
4. `pnpm deploy --prod` legte nur den virtuellen Store an, keine flachen
   Modulverweise (`Cannot find module 'yup'`). Lösung: nach dem Build
   `pnpm install --prod --ignore-scripts` (entfernt Dev-Abhängigkeiten) und den
   flachen Baum (`node-linker=hoisted`) direkt kopieren, dazu
   `packages/ai-provider` als Ziel des Workspace-Links.
5. Grün. Image 2,76 GB: 799 MB `node_modules`, 959 MB Producer unter
   `resources/p`, Rest Debian mit Chromium, chromedriver und ffmpeg. Container-
   Test: Start bis Phase „anmeldung“, PGlite bereit, sechs Producer registriert
   („wartet, nicht angemeldet“), `/data` angelegt, Device-Flow-Schleife läuft bis
   zum Keycloak-Schalter. Verkleinern (Producer-Abhängigkeiten teilen,
   Multi-Stage je Producer) ist Feinarbeit für später.

### 12.10 Stand R4: Setup-Seite und fensterlose Ersatzwege (v0.1.791, 2026-10-09)

- **Setup-Seite `/setup`** im Server, geschützt durch ein Setup-Token
  (`AVA_SETUP_TOKEN` oder beim Start erzeugt und ins Log geschrieben; Vergleich
  zeitkonstant). Drei Abschnitte: Anmeldung (Device-Flow-Code), API-Schlüssel je
  Anbieter (OpenAI, Google, Mistral, DeepSeek, xAI, Qwen; Anthropic gibt es nur
  als Abo-Anmeldung im Fenster), ChatGPT-Abo verbinden. Speichern ist gesperrt,
  solange `AVA_SECRETS_KEY` fehlt. `/status` zeigt den Modellzugang mit.
- **ChatGPT-Abo ohne Fenster** (`auth/siwc-headless.ts`): derselbe Flow wie im
  Fenster (PKCE, feste Weiterleitung 127.0.0.1:1456, dynamische Client-ID je
  Installation, Prüfung von State und Client-ID), nur dass die Person die
  Weiterleitungsadresse aus der Adresszeile auf `/setup` einfügt. Die
  Übernahme ins Provider-Store (`auth/siwc-anwenden.ts`) teilen sich Fenster
  (ipc/agent.ts) und Server, damit beide dieselbe Hülle schreiben. Link 15
  Minuten gültig.
- **Telegram-Sprachnachrichten** laufen ohne Fenster über ffmpeg
  (`AVA_FFMPEG_BIN` oder PATH; im Image installiert); auf dem Desktop bleibt der
  WebAudio-Weg, ffmpeg wird dort nicht vorausgesetzt.
- **Link-Beobachter** ohne Fenster: statischer Abruf per fetch mit
  Text-Extraktion aus dem HTML, ohne Scrollen, Pagination und Screenshot; steht
  so in der Notiz des Laufs. JavaScript-gerenderte Seiten liefern nur ihr
  Grundgerüst. **Discovery-Mini-Profile** nutzen ohne Fenster nur den
  fetch-Weg.

Geprüft: Typecheck, Build Desktop und Server, Wächter, Test-Skripte;
Rauchtest der Setup-Seite (401 ohne Token, Schlüssel speichern, Anmeldelink
erzeugen, falsche Callback-Adresse wird mit „Sicherheitsprüfung
fehlgeschlagen“ abgewiesen). Der echte ChatGPT-Tausch und ffmpeg mit einer
echten Telegram-Sprachnachricht sind im Container noch zu testen.

Damit ist §12.3 R1–R4 umgesetzt. Offen bleiben Stufe 3 (Node-Modus: LinkedIn,
Mikrofon, Anthropic-Abo-Anmeldung) und das MCP-Relais X1–X3 (§11.5).

### 12.11 Erste Instanz auf Fly (2026-10-09)

Zwei Apps in der persönlichen Fly-Organisation, Region Frankfurt:

| App | Konfiguration | Zweck |
|---|---|---|
| `headless-ava` | shared-cpu-2x, 4 GB, Volume `ava_data` 10 GB, `services/desktop/fly.server.toml` | der Kopf, ein Konto |
| `ava-ollama` | shared-cpu-2x, 2 GB, Volume `ollama_models` 15 GB, `infra/fly-ollama/fly.toml`, nur im 6PN-Netz | Embeddings (embeddinggemma) |

Deploy aus der Repo-Wurzel (Kontext), Dockerfile-Pfad gilt relativ zur
Konfigurationsdatei: `fly deploy "$(git rev-parse --show-toplevel)" -c
services/desktop/fly.server.toml --build-secret npm_token="$NPM_TOKEN"`.
Ein Durchlauf dauert etwa 15 Minuten (511 MB Kontext, Producer-Vendoring im
Builder, 2,8 GB Image). Secrets: `AVA_SECRETS_KEY`, `AVA_SETUP_TOKEN`.

Was der erste Tag gezeigt hat (alle Punkte behoben und im Code kommentiert):

1. Keycloak erzwingt am Client PKCE auch für den Device Flow; der Device-
   Request trägt jetzt `code_challenge`, der Token-Abruf `code_verifier`.
2. Die Erreichbarkeitsprobe des Ollama-Supervisors (500 ms) war für den
   Sidecar im Privatnetz zu knapp; externe Hosts bekommen 5 s.
3. Ein gespeicherter Schlüssel schaltet den aktiven Anbieter nicht um; ohne
   Oberfläche blieb Ollama aktiv und der Website-Producer kam nicht ans Modell.
   Der Server wechselt beim Speichern und beim Start auf den Anbieter mit
   Schlüssel, Ollama bleibt für Embeddings.
4. Die Producer lesen `OLLAMA_URL`; der Manager setzte sie nur lokal. Mit
   `AVA_OLLAMA_HOST/PORT` zeigt sie auf den Sidecar.
5. `fly deploy` löst `[build].dockerfile` relativ zur Konfiguration auf; der
   Kontext kommt aus dem ersten Argument.

Erster Durchlauf mit einer echten Firma (Strategic IT GmbH, Herford, über
`/v1/imports/from-list` mit Device-Flow-Token): Register, Website, Kontakte
und Kundenseiten liefen auf dem Server durch (1 Firma fertig, 4 Schritte, 2
übersprungen); Chromium 154 passt zum chromedriver des Images. Nach dem
vierten Deploy bettet der Publikations-Producer gegen den Sidecar ein
(„10/10 Blöcke lokal eingebettet“, 4 s; „26/26“, 2 s). Noch anzusehen: die
Meldungen „Couldn't find token“ und „deep research … url is a required
field“ des Website-Producers (Research-Einstellungen ohne Schlüssel), beide
ohne Folgen für das Ergebnis.

Betriebskosten bei Dauerbetrieb rund 35 bis 40 $ im Monat (Kopf 21 bis 22,
Sidecar 10 bis 11, Volumes rund 4, Traffic wenige Dollar) plus Modellkosten.

### 11.7 Stand X1–X3: Kopf-Relais gebaut (2026-10-09)

Umgesetzt wie in §11.2 Weg B, ohne eigene Adresse je Kopf:

- **Gateway** (`lib/kopf-relais.ts`): WebSocket-Upgrade auf `/kopf-relais`
  mit `access_token` (dieselbe Prüfung wie `/v1`, über die kleine Route
  `/v1/kopf-relais/wer`); ein Kopf je Konto, ein zweiter löst den ersten ab
  (Code 4001); Ping/Pong alle 30 s; Aufrufe mit 120 s Frist. `routes/mcp.ts`
  blendet die Werkzeuge des verbundenen Kopfs in `tools/list` ein (ohne
  Namenskollisionen mit den Gateway-Werkzeugen), reicht `tools/call` durch und
  sagt in `instructions`, ob die AVA des Nutzers gerade verbunden ist.
  Org-Schalter `mcp.kopf` (Standard an). Abhängigkeit `ws` neu.
- **Kopf** (`core/relais/kopf-relais.ts`): globales WebSocket aus Node,
  Verbindung nach Anmeldung, Reconnect mit Backoff. Gemeldet werden eine
  Kernmenge aus der ToolRegistry (sofern vorhanden: company_*, alerts_*,
  memory_*, profile_get, workflow_*, transaction_*, skill_*, …) und zwei
  Meta-Werkzeuge: `werkzeug_suchen` (Stichwortsuche über alle rund 280
  Werkzeuge, liefert Schema) und `werkzeug_ausfuehren` (führt jedes aus).
- **Rückfragen und Freigaben:** Vollmacht-Stufe des Kanals ist „none“, also
  geht jede Freigabe (`confirmAction`) und jede Rückfrage (`askChoice`,
  `askText`) an den Nutzer: Das Werkzeug bricht mit `rueckfrage` und einem
  Token ab, der Agent fragt den Menschen und wiederholt denselben Aufruf mit
  `_antworten: { "<token>": "<wert>" }`. Der zweite Lauf startet von vorn und
  findet die Antwort vor. Destruktives kommt so nie ohne Mensch durch
  (Entscheidung §11.6 Nr. 2, strengste Lesart). Jeder Aufruf landet im Audit
  (`mcp.relais.call`), der Gateway protokolliert nur Werkzeugname und Dauer
  (§11.6 Nr. 3).
- Verdrahtung in `bootstrapCore`: Start nach Anmeldung, im Worker-Modus
  angehalten, `AVA_MCP_RELAIS=0` schaltet ab. Gilt für Desktop-App und Server
  gleichermaßen. Läuft der Desktop parallel zum Server, bleibt der zuerst
  verbundene Kopf; der zweite wird mit 4002 abgewiesen und versucht es alle
  fünf Minuten wieder (kein gegenseitiges Verdrängen).

Live-Test über mcp.ava.bi mit dem Fly-Kopf (2026-10-09): `tools/list` liefert
23 Werkzeuge (10 Gateway, 13 Kopf), `instructions` meldet „verbunden“,
`werkzeug_suchen` findet über die ganze Registry, `company_get` und
`werkzeug_ausfuehren(workflow_list)` laufen über den Kopf, und die
Rückfrage-Schleife (`vorschlaege_config` → `rueckfrage` mit Token → zweiter
Aufruf mit `_antworten` „nein“ → abgebrochen) funktioniert.

Offen: `ava_fragen` (Agent als Werkzeug, §11.3 Nr. 3), MCP Apps für Ansichten,
Kernmenge nachschärfen (heute 11 von 23 Wunschnamen in der Registry).

