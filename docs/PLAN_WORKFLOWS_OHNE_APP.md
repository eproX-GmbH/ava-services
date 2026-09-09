# Plan: Workflows ohne laufende App ausführen

Stand 2026-09-09 (Desktop v0.1.599). Letzter offener Punkt aus
docs/PLAN_WORKFLOWS.md (§9a). Ergänzt docs/PLANS_server_deployment.md, das den
Server-Betrieb von AVA insgesamt beschreibt.

## 1. Ausgangslage

Zeitpläne und Ereignis-Trigger greifen heute nur, solange AVA auf dem Rechner
des Nutzers läuft. Versäumte Läufe werden nicht nachgeholt (Entscheidung
2026-09-09). Auf macOS bleibt der Prozess nach Schließen des Fensters aktiv,
auf Windows und Linux beendet Schließen die App (`window-all-closed`). Es gibt
keinen Autostart beim Anmelden und kein Tray-/Menüleisten-Symbol.

Was ein Lauf braucht (RunnerDeps): ToolRegistry mit allen Tools, den
LLM-Provider-Manager (Schlüssel des Kontos), Gateway-Zugang mit Login-Token,
Workflow-Store (lokale JSON-Dateien), Vollmacht-Stufe, Meldungen (Panel,
OS-Toast, Telegram), Audit-Protokoll. Alles davon lebt im Electron-Hauptprozess.

## 2. Leitplanken

- **Compute-Lokalität:** Nutzer rechnen auf ihren Geräten (LLM, Scraping).
  Der Betreiber hostet nur das Substrat (Gateway, Keycloak, Datenbank).
- **Schlüssel bleiben beim Konto:** BYOK-Schlüssel verlassen das Gerät nicht;
  Org-Schlüssel liegen verschlüsselt im Gateway (TENANT_SECRETS_KEY).
- **Freigaben bleiben Menschensache:** Schreibende Schritte laufen nur mit
  Node-Freigabe; Mails nie ohne.
- Keine Versprechen auf der Website, bevor etwas live ist.

## 3. Optionen

### A. Betreiber-Worker in der Cloud (Fly)

Ein Dienst des Betreibers führt Zeitplan-Workflows aller Nutzer aus.

- Bricht die Compute-Lokalität und die Schlüssel-Regel: Der Worker bräuchte
  Modellzugänge, CRM-Tokens, Mail-Zugänge und Telegram-Token des Nutzers auf
  Betreiber-Seite. Für Enterprise-Kunden (Datenschutz-Argument „alles lokal“)
  ein Rückschritt.
- Producer (Scraping, Profile) liefen ebenfalls beim Betreiber → Kosten und
  Rechtsrisiko (Scraping-Herkunft) wandern zum Betreiber.
- **Nicht empfohlen.** Nur als Enterprise-Sonderfall mit eigenem Vertrag
  denkbar, dann als Option B beim Kunden gehostet.

### B. Headless-AVA je Nutzer (Self-Hosting oder Betreiber-Container je Kunde)

Der bereits skizzierte Weg aus docs/PLANS_server_deployment.md: `@ava/core`
(heutiger Hauptprozess ohne Electron), `@ava/server` als Wrapper mit
Chat-Providern (Telegram, Mail) und Docker-Image. Workflows sind darin
automatisch enthalten, weil WorkflowService nur RunnerDeps braucht.

- Erfüllt alle Leitplanken: Schlüssel und Rechenlast bleiben in der Hoheit
  des Kunden (eigener Server oder dedizierter Container).
- Aufwand laut Server-Plan: Foundation 1–2 Wochen, Skeleton 1 Woche, Provider
  und Attachments 3–5 Tage, Wizard 1–2 Wochen. Workflows-spezifisch kommen
  hinzu: Workflow-Store und Freigaben ohne Renderer (Chat-Tools und Telegram
  reichen, Editor entfällt), Synchronisation der Definitionen zwischen
  Desktop und Server (siehe §5).
- Realistisch 5–7 Wochen bis zum ersten Kunden-Container.

### C. Desktop als Dauerläufer („Bereitschaft“)

Die App bleibt nach dem Anmelden im Hintergrund aktiv und führt Zeitpläne
aus, ohne dass ein Fenster offen ist.

- Autostart beim Anmelden (`app.setLoginItemSettings`, Windows-Registry über
  electron-builder), Start minimiert ohne Fenster.
- Tray-/Menüleisten-Symbol mit Status („Bereit · 3 Zeitpläne · nächster 07:00“),
  Öffnen, Freigaben, Beenden. Schließen des Fensters beendet die App auf
  Windows/Linux nicht mehr, wenn Bereitschaft aktiv ist.
- Schlaf/Ruhezustand: `powerMonitor` für resume → verpasste Fenster (20 min)
  bleiben verpasst (kein Nachholen), aber der nächste Tick läuft sofort.
  Optional `powerSaveBlocker` nur während eines laufenden Laufs.
- Login-Token-Erneuerung ohne Fenster muss sicher funktionieren
  (Refresh-Token im safeStorage; heute vorhanden, zu prüfen im Kopfzustand).
- Bereitschaft ist Opt-in in den Einstellungen, mit Chat-Tool
  (`workflow_readiness_set`, confirmAction) und ehrlicher Anzeige in der
  Workflows-Liste: „Zeitpläne laufen nur bei Bereitschaft/geöffneter App“.
- Aufwand: 4–6 Tage. Kein neuer Dienst, keine neuen Datenwege.
- Grenze: Rechner aus oder Deckel zu (ohne Netz) → kein Lauf. Das ist ehrlich
  kommunizierbar („AVA läuft, solange dein Rechner läuft“).

## 4. Empfehlung

1. **Jetzt: Option C** als schneller, regelkonformer Schritt. Deckt den
   Alltagsfall „Laptop läuft, Fenster zu“ und Windows-Nutzer, die die App
   schließen, ab. Marketing-Aussage bleibt: „solange dein Rechner läuft“.
2. **Danach: Option B** als eigenes Vorhaben entlang des Server-Plans, zuerst
   für Enterprise-/Self-Hosting-Kunden. Workflows sind dort ohne Zusatzarbeit
   enthalten; nötig sind nur Store-Sync und Freigaben ohne Editor.
3. **Option A** nicht verfolgen.

## 5. Offene Entscheidungen

1. Bereitschaft standardmäßig aus (Opt-in) oder beim Anlegen des ersten
   Zeitplans vorschlagen? Vorschlag: Opt-in, Hinweis-Dialog beim ersten
   Zeitplan.
2. Tray-Symbol auch auf macOS (Menüleiste) oder nur Dock? Vorschlag: beides,
   Menüleiste zeigt Freigaben-Zähler.
3. Für Option B: Wo liegt der Workflow-Store, wenn Desktop und Server
   parallel existieren? Vorschlag: Der Server ist Master für „auf Server
   ausführen“ markierte Workflows; Desktop-Editor bearbeitet über die
   Org-Teilen-Route (TenantWorkflow) statt lokal. Braucht ein Feld
   `runsOn: "desktop" | "server"` in der Definition.
4. Freigaben in Option B: Telegram und Mail-Antwort reichen? Vorschlag: ja,
   plus Gateway-Route für die Freigabe-Liste, damit der Desktop sie anzeigt.

## 6. Umsetzungsschritte Option C (wenn freigegeben)

| Schritt | Inhalt | Dateien |
|---|---|---|
| C1 | Einstellung „Bereitschaft“ (Store, IPC, Einstellungen-Seite, Chat-Tool) | settings, src/main/index.ts, Settings.tsx, tools |
| C2 | Autostart beim Anmelden, Start ohne Fenster, `window-all-closed` je nach Bereitschaft | src/main/index.ts, electron-builder.yml |
| C3 | Tray/Menüleiste mit Status, Freigaben-Zähler, Öffnen/Beenden | src/main/tray.ts (neu) |
| C4 | powerMonitor resume → Scheduler-Tick; Token-Refresh im Kopfzustand prüfen | workflows/index.ts, auth |
| C5 | Anzeige in Workflows-Liste und Editor-Trigger-Panel („läuft bei Bereitschaft“), Website-Nachtrag | Workflows.tsx, WorkflowEditor.tsx, docs |
