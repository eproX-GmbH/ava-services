# Implementierungsplan — URL-/Website-Überwachung (Link-Monitoring)

Status: in Arbeit · Ziel-Feature: AVA überwacht einen vom Nutzer angegebenen
Link in einstellbarer Frequenz, simuliert echtes Nutzerverhalten in einem
Headless-Browser, befolgt pro Link hinterlegte Anweisungen, erkennt
**Änderungen** zwischen Durchläufen und löst bei Änderung eine Mitteilung
(OS-Push + AVA-Alarm-Glocke) aus.

## Anforderungen (aus User-Brief)

1. Nutzer gibt Link im Chat ein + sagt z. B. „Sag mir, wenn sich hier etwas
   ändert" / „Gib alle x Minuten ein Update".
2. Kommentarloser Link → AVA fragt aktiv: „Soll ich überwachen? Frequenz:
   Alle 5 Min / Stündlich / Täglich / Wöchentlich / Freitext".
3. AVA ruft den Link wiederholt auf, bis der Nutzer stoppt.
4. Pro Link speicherbare **Anweisungen**, worauf zu achten ist.
5. Öffnen über Headless-Browser mit simuliertem Nutzerverhalten (wie
   LinkedIn-Signalüberwachung).
6. LinkedIn-Links: automatisch hinterlegte LinkedIn-Anmeldedaten nutzen
   (→ Unternehmensseiten / Profile beobachtbar).
7. Default ohne Angabe: **täglich** (24 h ab Eingabe).
8. Einstellungen-Bereich: überwachte Links + Anweisungen anlegen/ändern/
   löschen, Frequenz einstellbar (min **5 Min**, max **wöchentlich**).
9. Max **5 gleichzeitig aktive** Überwachungen; unbegrenzt anlegbar,
   überzählige müssen pausiert sein. Pausieren/Fortsetzen möglich.
10. Vollständige Verwaltungs-**Tools** für den KI-Agenten.
11. Pro Durchlauf **Timeout 3 Minuten** → danach Stop, Aggregation,
    Speicherung. Pagination + gezieltes Achten auf etwas (z. B. neue
    Produkte) gemäß Anweisung.
12. Bei festgestellter Änderung (z. B. „Produkt jetzt verfügbar") → neue
    Mitteilung (Push + Alarm-Glocke).

## Wiederverwendete bestehende Infrastruktur

| Zweck | Vorlage im Code |
|---|---|
| Recurring-Timer + Boot-Rehydrate + Caps + Auto-Pause | `main/scheduler/{store,supervisor}.ts` |
| PGlite-Store-Muster (lazy start, Schema, EventEmitter, Caps) | `main/scheduler/store.ts` |
| Headless-Browsing + Stealth + menschliches Scrollen | `main/linkedin/{scraper,stealth}.ts` |
| LinkedIn-Session (verschlüsselte Cookies, safeStorage) | `main/linkedin/session.ts` → `readStoredSession()` |
| OS-Push-Notification (Prefs, Quiet-Hours, Klick-Fokus) | `main/notifications.ts` → `notifyForAlert(alert)` |
| Alarm-Glocke / Alerts (JSONL, unreadCount, dedup) | `main/agent/alerts-store.ts`, Renderer `store/alerts.ts` |
| Agent-Tool-Muster (defineTool + yup + askChoice) | `main/agent/tools/watches.ts` |
| Tool-Bundle (tool_search/tool_load) | `main/agent/tools/meta.ts` (`KNOWN_BUNDLES`) |
| Settings-Section + Zustand-Mirror + Bridge | `routes/settings/{SchedulerSection,WatchesSection}.tsx`, `store/watches.ts` |
| Autonome AVA-Analyse (optional, später) | `agent/orchestrator.ts` `startAutonomousConversation` |

## Architektur-Entscheidungen

- **Eigener `LinkMonitorSupervisor` + Store** statt Überladung des
  `ScheduledJobsSupervisor`: abweichende Constraints (max 5 aktiv,
  Frequenz 5 Min–wöchentlich, unbegrenzt anlegbar/pausierbar, pro-Link
  Anweisungen, Snapshots/Diff). Timer-/Rehydrate-/Auto-Pause-Logik wird
  vom Scheduler-Muster übernommen.
- **Frequenz** als `intervalMinutes` (Zahl). UI-Presets 5/15/60/1440/
  10080 Min + Freitext; geklemmt auf `[5, 10080]`. Default 1440 (täglich).
- **Snapshots + Diff:** Pro Durchlauf werden strukturierte Beobachtungen
  (LLM-extrahiert, gemäß Anweisung) + ein Inhalts-Hash gespeichert. Diff
  gegen den vorherigen Snapshot: Hash-Schnellpfad „keine Änderung", sonst
  LLM-Semantik-Diff → bool `changed` + deutsche `changeSummary`.
- **Bei Änderung:** `alertsStore.add(kind:"link-change")` →
  `notifications.notifyForAlert()` → `broadcastAlertsChanged()`. (Autonome
  AVA-Analyse als spätere Ausbaustufe, nicht MVP.)
- **Browser-Engine: OFFENE ENTSCHEIDUNG** (siehe unten) — bestimmt den
  Scraping-Teil (Phase 3). Alles andere ist engine-unabhängig.

### Offene Entscheidung: Browser-Engine
- **Option A — Electron-BrowserWindow im Desktop-Main** (wie
  LinkedIn-Scraper). Direkter Zugriff auf `readStoredSession()` für
  LinkedIn-Cookies, Stealth bereits vorhanden, in-process, schnellster
  Weg. (Kein „echtes" Selenium, aber funktional identisch.)
- **Option B — Selenium Headless Chrome** (wie `structured-content`).
  Entspricht der wörtlichen Vorgabe; LinkedIn-Cookies via
  `driver.manage().addCookie()` injizierbar. Erfordert Bundeln von
  selenium-webdriver + chromedriver in den Desktop ODER einen neuen
  lokalen Producer-Subprozess (schwerer, Cookie-Übergabe an Subprozess
  nötig).
- **Empfehlung:** Option A für MVP (reuse LinkedIn-Infra 1:1), später
  optional auf Producer/Selenium migrierbar, da die Engine hinter einem
  `BrowseEngine`-Interface gekapselt wird.

## Phasen & ToDos

- **LM0 — Shared Types + Konstanten** (`shared/types.ts`)
  `LinkMonitor`, `LinkMonitorStatus`, `LinkMonitorRun`/Snapshot,
  `LinkMonitorFrequencyPreset`, Caps (`LINK_MONITOR_ACTIVE_CAP=5`,
  `MIN/MAX/DEFAULT_INTERVAL_MINUTES`).
- **LM1 — PGlite-Store** (`main/link-monitor/store.ts`)
  Tabellen `link_monitors` + `link_monitor_runs`. CRUD, Active-Cap (5)
  bei create/resume, pause/resume, `recordRun` + Snapshot-Persistenz,
  `previousSnapshot(id)`, EventEmitter `changed`.
- **LM2 — Browse-Engine-Interface + Impl** (`main/link-monitor/browser.ts`)
  `BrowseEngine.open(url, {instructions, signal, deadline})` →
  rohe Seiten-Repräsentation (Text/DOM + ggf. paginierte Abschnitte),
  Stealth + menschliches Verhalten, LinkedIn-Cookie-Injektion bei
  `*.linkedin.com`. **3-Min-Timeout** via AbortSignal + Deadline.
- **LM3 — Extractor + Diff** (`main/link-monitor/{extractor,diff}.ts`)
  LLM-Extraktion strukturierter Beobachtungen gemäß Anweisung →
  Snapshot; Hash-Schnellpfad; LLM-Semantik-Diff → `changed` +
  `changeSummary`.
- **LM4 — Supervisor** (`main/link-monitor/supervisor.ts`)
  Boot-Rehydrate aktiver Monitore, Per-Monitor-Timer (30-Min-Re-Arm
  gegen Sleep-Drift), Pipeline open→extract→diff, Concurrency-Limit,
  Auto-Pause nach N Fehlversuchen, bei Änderung → Alert+Push+Glocke.
  Boot in `main/index.ts`.
- **LM5 — IPC + Preload** (`main/index.ts`, `preload/index.ts`)
  `linkMonitor:list/create/update/remove/pause/resume/runNow` +
  `onChanged`. `window.api.linkMonitor` + Typ-Exports.
- **LM6 — Agent-Tools + Bundle + Prompt**
  (`main/agent/tools/link-monitor.ts`, `meta.ts`, `prompts.ts`)
  `link_monitor_register/list/update/remove/pause/resume/run_now`.
  Register mit `askChoice`-Frequenzwahl. Bundle + queryHints. Prompt:
  kommentarloser Link → Überwachung anbieten; „sag mir wenn sich was
  ändert" → registrieren.
- **LM7 — Settings-UI** (`routes/settings/LinkMonitorSection.tsx`,
  `store/link-monitor.ts`, `AutomatisierungenTab.tsx`, CSS)
  Liste + Anlegen (URL + Anweisung + Frequenz) + Edit + Löschen +
  Pause/Resume, „X/5 aktiv"-Badge, letzter Lauf/letzte Änderung.
- **LM8 — Typecheck/Lint + Bump + Ship.**

## Grenzen / Nicht-Ziele (MVP)
- Keine autonome AVA-Chat-Analyse bei Änderung (nur Notification +
  gespeicherte `changeSummary`) — späterer Ausbau.
- Pagination „best effort" gemäß Anweisung, kein beliebig tiefes Crawling.
- Snapshots werden begrenzt vorgehalten (z. B. letzte N pro Monitor).
