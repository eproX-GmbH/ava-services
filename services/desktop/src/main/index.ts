// Electron-Einstieg (docs/PLAN_AVA_CLOUD.md §12, Schritt R2b).
//
// Diese Datei ist die Hülle: Plattform setzen, Fenster, Protokolle, Sitzungen,
// IPC-Registrierung und die Beenden-Kette. Die gesamte Komposition der AVA
// (Stores, Dienste, Orchestrator, Producer) liegt in src/core/bootstrap.ts und
// ist für den headless Server dieselbe.

// Plattform-Schicht zuerst: Stores lesen ihre Pfade schon beim Laden.
import "./platform-electron";
import { registerPersonenIpc } from "./ipc/personen";
import { registerDiscoveryIpc } from "./ipc/discovery";
import { registerSpracheIpc } from "./ipc/sprache";
import { registerRechercheIpc } from "./ipc/recherche";
import { registerSkillsIpc } from "./ipc/skills";
import { registerAgentIpc } from "./ipc/agent";
import { registerInstanzIpc } from "./ipc/instanz";
import { registerCrmIpc } from "./ipc/crm";
import { registerStammdatenIpc } from "./ipc/stammdaten";
import { registerVorschlaegeIpc } from "./ipc/vorschlaege";
import { registerKontoIpc } from "./ipc/konto";
import { registerLaufzeitIpc } from "./ipc/laufzeit";
import { registerSystemIpc } from "./ipc/system";
import { registerMailEntwurfIpc } from "./ipc/mail-entwurf";
import { registerRelevanzIpc } from "./ipc/relevanz";
import { registerAblaeufeIpc } from "./ipc/ablaeufe";
import { registerWissenIpc } from "./ipc/wissen";
import { registerStimmeIpc } from "./ipc/stimme";
import { registerBeobachtungIpc } from "./ipc/beobachtung";
import { registerKommunikationIpc } from "./ipc/kommunikation";
import { registerVerlaufIpc } from "./ipc/verlauf";
import { registerMeldungenIpc } from "./ipc/meldungen";
import { guardAllKnownSessions, setDownloadBlockedListener } from "./download-guard";
import { app, BrowserWindow, protocol, session } from "electron";
import "./file-logger-init";
import "./account-space-init";
import { setMaxListeners } from "node:events";
import { join } from "node:path";
import { quitStep, writeLineSync, setQuitPhase, istQuitAnzeigePhase } from "./file-logger";
import { startWatchdog } from "./watchdog";
import { beendeVerwaisteBrowser } from "./browser-sweep";
import { producerLogBuffer } from "./producer-log-buffer";
import { registerScreenshotProtocol } from "./producer-screenshots";
import { registerLinkedInMediaProtocol } from "./linkedin/media-protocol";
import { initBilling } from "./billing";
import * as relevanz from "./relevanz";
import { initLinkedIn } from "./linkedin";
import { leiteLinksNachAussen } from "./externe-links";
import { windows } from "../core/platform";
import { bootstrapCore, type Core } from "../core/bootstrap";

// v0.1.532 — 11 before-quit-Handler (Breadcrumbs je Modul) sind
// Absicht; Node warnt ab 10. Vorher stand bei jedem Start eine
// MaxListenersExceededWarning im Log.
setMaxListeners(40, app);


// Beenden-Anzeige: Dieser Handler steht als ERSTER in der Kette. Beim ersten
// before-quit unterbricht er das Beenden, laesst den Renderer das Overlay
// „Wird beendet“ zeichnen und stoesst 150 ms spaeter app.quit() erneut an.
// Alle quitStep-Schritte der Module sind in der Anzeige-Phase aufgeschoben
// und laufen beim zweiten Durchlauf. Notausgang nach 20 s: app.exit(0).
let beendenAnzeigeGezeigt = false;
app.on("before-quit", (e) => {
  if (beendenAnzeigeGezeigt) {
    setQuitPhase("stoppen");
    // 2026-10-04: zweiter Aufraeum-Durchgang. Verborgene Helfer-Fenster, die
    // noch laden, duerfen das Beenden nicht bis zum Notausgang aufhalten.
    setTimeout(() => {
      for (const w of BrowserWindow.getAllWindows()) {
        try {
          if (!w.isDestroyed() && !w.isVisible()) {
            writeLineSync("INFO ", `[quit] verborgenes Fenster ${w.id} haengt noch → zerstoert`);
            w.destroy();
          }
        } catch {
          /* schon weg */
        }
      }
    }, 1_500).unref();
    return;
  }
  const fenster = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
  if (fenster.length === 0) {
    setQuitPhase("stoppen");
    return;
  }
  beendenAnzeigeGezeigt = true;
  setQuitPhase("anzeige");
  e.preventDefault();
  for (const w of fenster) {
    try {
      w.webContents.send("app:wird-beendet");
    } catch {
      /* Fenster schon weg */
    }
  }
  setTimeout(() => app.quit(), 150);
  setTimeout(() => {
    writeLineSync("WARN ", "[quit] Notausgang nach 20 s: app.exit(0)");
    app.exit(0);
  }, 20_000).unref();
});

// Register custom `ava-screenshot://` protocol as a privileged scheme.
// Must be called before app.whenReady() (electron requirement). The
// actual file-serving handler is wired in registerScreenshotProtocol()
// inside the whenReady callback. Marking it as `standard` lets the
// renderer use it in <img src=...> like a normal http:// URL.
protocol.registerSchemesAsPrivileged([
  {
    scheme: "ava-screenshot",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      bypassCSP: false,
    },
  },
  // L6 — same shape, serves LinkedIn-Beobachter media thumbnails.
  {
    scheme: "ava-linkedin-media",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      bypassCSP: false,
    },
  },
]);

/**
 * v0.1.387 — Das echte AVA-Hauptfenster finden, ohne das persistente
 * LinkedIn-Scraper-Fenster zu erwischen (das ist off-screen + unsichtbar und
 * mit `__avaLinkedInScraper` markiert). Liefert das erste sichtbare
 * Nicht-Scraper-Fenster, sonst null.
 */
function getMainAppWindow(): BrowserWindow | null {
  // v0.1.481 — POSITIV nach dem Hauptfenster suchen statt Helfer
  // aufzuzaehlen. Der alte Ausschluss kannte nur den LinkedIn-Scraper;
  // inzwischen gibt es weitere versteckte Helfer (Crawl-Browser-
  // Fallback des Profil-Workers, Audio-Decoder, Link-Monitor) — stand
  // so einer vorn in getAllWindows(), zeigte der Dock-Klick ein
  // LEERES unsichtbares Fenster statt AVA (Live-Befund).
  const all = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
  return (
    all.find(
      (w) => (w as unknown as { __avaMainWindow?: boolean }).__avaMainWindow,
    ) ??
    // Fallback (sollte nie greifen): ein SICHTBARES Nicht-Helfer-Fenster.
    all.find(
      (w) =>
        w.isVisible() &&
        !(w as unknown as { __avaLinkedInScraper?: boolean })
          .__avaLinkedInScraper,
    ) ??
    null
  );
}

function createMainWindow(): BrowserWindow {
  // v0.1.386 — Vollintegrierte Titelleiste: die native System-Leiste
  // ausblenden und die App-eigene `.topbar` (64px) zur Fensterleiste machen,
  // damit Fenster-Buttons + Branding optisch eine Einheit bilden (wie bei
  // anderen nativen Mac-Apps). macOS: `hiddenInset` lässt die Ampel-Buttons
  // eingebettet sichtbar — `trafficLightPosition` zentriert sie vertikal in
  // der 64px-Leiste. Windows: `titleBarOverlay` zeichnet Min/Max/Schließen
  // über die Leiste; Farben werden zur Boot-Zeit (hell) gesetzt und bei
  // Theme-Wechsel via `window:setTitleBarOverlay` nachgezogen.
  const isMac = process.platform === "darwin";
  const isWin = process.platform === "win32";
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    ...(isMac
      ? {
          titleBarStyle: "hiddenInset" as const,
          trafficLightPosition: { x: 19, y: 24 },
        }
      : {}),
    ...(isWin
      ? {
          titleBarOverlay: {
            color: "#F2F7F6",
            symbolColor: "#0A1F2A",
            height: 64,
          },
        }
      : {}),
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  // v0.1.481 — positive Markierung fuers Dock-Klick-Routing
  // (getMainAppWindow): NUR dieses Fenster ist das AVA-Hauptfenster.
  (win as unknown as { __avaMainWindow?: boolean }).__avaMainWindow = true;

  win.on("ready-to-show", () => win.show());

  // Externe Links gehoeren in den Browser des Nutzers. Deckt seit v0.1.692
  // auch gewoehnliche Anker ab: `setWindowOpenHandler` allein faengt nur
  // window.open und target="_blank", ein schlichtes <a href="https://…">
  // ersetzte die App bis dahin durch die Seite.
  leiteLinksNachAussen(win);

  if (process.env["ELECTRON_RENDERER_URL"]) {
    void win.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    void win.loadFile(join(__dirname, "../renderer/index.html"));
  }

  // (v0.1.7-v0.1.20 carried an `app.isPackaged → openDevTools` line
  // that auto-opened the inspector in packaged builds while we
  // diagnosed the OpenAI ECONNRESET. Removed once the cause was
  // pinned down. DevTools stays available via Cmd+Option+I; users
  // who want it can still pop it manually.)
  return win;
}

/** Die laufende AVA; gesetzt, sobald bootstrapCore fertig ist (Beenden-Kette). */
let core: Core | null = null;

app.whenReady().then(async () => {
  // v0.1.335 — Track pending Wake-Acks: pro Resume-Event eine nonce,
  // die zugehoerigen Window-IDs muessen alle innerhalb 6s acken.
  // Renderer-Code (AppShell.tsx) ruft window.api.acknowledgeWake(nonce)
  // im power:resumed-Handler auf.
  const pendingWakeAcks = new Map<string, Set<number>>();

  const c = await bootstrapCore({
    onResume: () => {
      // v0.1.335 — Renderer-Wake-Recovery komplett umgebaut.
      //
      // Vorher (v0.1.327): Renderer empfaengt `power:resumed`, wartet
      // 3s, pinged Main, bei Timeout `window.location.reload()`. Das
      // funktioniert NUR wenn der Renderer-Process gesund genug ist um
      // das IPC-Event zu verarbeiten. Bei V8-Wake-Deadlock auf macOS
      // hangt aber genau das in der wedged Event-Loop -> Recovery
      // greift nicht. Real-Run-Reports v0.1.327 ff. zeigen dass das
      // Wake-Hang weiter auftrat trotz aller Patches.
      //
      // Neue Strategie: MAIN-driven Force-Reload. Main schickt
      // power:resumed UND erwartet ein power:ack zurueck innerhalb
      // 6 Sekunden. Wenn KEIN ack ankommt -> der Renderer ist wedged
      // -> Main triggert webContents.reloadIgnoringCache() von SEINER
      // Seite aus. Das geht durch die Renderer-Loop hindurch weil
      // Electron Cross-Process IPC ist.
      const onScreenWindows = BrowserWindow.getAllWindows().filter((w) => {
        if (w.isDestroyed()) return false;
        // v0.1.335 — Off-Screen Scraper-Window (LinkedIn, seit v0.1.330)
        // ist headless, hat keine UI, braucht keinen Reload und ein
        // reload waere disruptiv (Session-Zustand weg). Filter raus.
        try {
          const b = w.getBounds();
          if (b.x < -100 || b.y < -100) return false;
          if (typeof w.getOpacity === "function" && w.getOpacity() < 0.1) return false;
          return true;
        } catch {
          return false;
        }
      });
      console.log(
        `[power] resume: kicking ${onScreenWindows.length} on-screen window(s) (skipping headless)`,
      );
      // Repaint + Soft-Notify (haendigt React-Stores die Chance fuer
      // Self-Recovery wenn der Renderer GESUND ist).
      const wakeNonce = `wake-${Date.now()}`;
      for (const w of onScreenWindows) {
        try {
          w.webContents.invalidate();
        } catch {
          /* best-effort */
        }
        try {
          w.webContents.send("power:resumed", { nonce: wakeNonce });
        } catch {
          /* best-effort */
        }
      }
      // Backstop: wenn KEIN Renderer innerhalb 6s mit einem ack auf
      // diese nonce antwortet, ist der Renderer wedged -> Force-Reload.
      // Wir verfolgen acks via globaler Map (siehe IPC-Handler unten).
      pendingWakeAcks.set(wakeNonce, new Set(onScreenWindows.map((w) => w.id)));
      setTimeout(() => {
        const pending = pendingWakeAcks.get(wakeNonce);
        pendingWakeAcks.delete(wakeNonce);
        if (!pending || pending.size === 0) {
          console.log(`[power] resume: all windows ack'd nonce=${wakeNonce}`);
          return;
        }
        console.warn(
          `[power] resume: ${pending.size} window(s) DID NOT ack within 6s -> force-reloading`,
        );
        for (const winId of pending) {
          const w = BrowserWindow.fromId(winId);
          if (!w || w.isDestroyed()) continue;
          try {
            w.webContents.reloadIgnoringCache();
            console.log(`[power] resume: reloaded window ${winId}`);
          } catch (err) {
            console.warn(
              `[power] resume: reload window ${winId} failed:`,
              err instanceof Error ? err.message : String(err),
            );
          }
        }
      }, 6000);
    },
  });
  core = c;
  const { APP_CONFIG, GATEWAY_URL, agent, agentRegistry, alertPrefs, alerts, apifyZugangInfo, attachments, audit, auditStore, auth, autonomyStore, broadcastAlertsChanged, broadcastDailyLimitStatus, broadcastMailSnapshot, broadcastMissingProducers, broadcastWatchesChanged, computeDailyLimitStatus, crmManager, customerProfiles, cycleCompanyContact, discoveryMatches, externalServiceMonitor, freshness, freshnessPrefs, gatewayClient, generalMemory, getTenantTierCached, heartbeat, hintergrundAufgaben, icpStore, interest, knowledge, knowledgeStore, memory, memoryProbe, notifications, ollama, ollamaUpdater, postgres, producers, providerConfigStore, providers, publicationStore, registerQueueStatus, researchBundle, researchStore, resolveApifyAccess, retryTicker, selfCorrectionsStore, skillStore, skillsPrefs, skillsTrust, spracheRelay, spracheStand, spracheStore, statusWatcher, storageDeps, telegramSnapshot, telegramStore, toSkillRow, updater, usageStore, userProfile, watchStore, wf, whisper, workerModusMerkerLoeschen, workerModusMerkerSetzen } = c;

  // Protokoll-Handler (Schemata sind oben vor whenReady privilegiert).
  registerScreenshotProtocol();
  registerLinkedInMediaProtocol();
  app.on("browser-window-created", () => broadcastMissingProducers());

  // ---- Renderer permission grants (Phase 8.n2) -----------------------------
  //
  // Electron's default `setPermissionRequestHandler` denies every
  // permission request silently. That's why `getUserMedia({ audio })`
  // failed with NotAllowedError before — Chromium's permission prompt
  // never even surfaced because Electron killed the request first.
  //
  // We grant the small set of permissions the app actually needs:
  //   - `media` / `mediaKeySystem`: microphone for voice mode (8.n2)
  //   - `clipboard-sanitized-write`: future "Copy answer" affordance
  //   - everything else: deny
  //
  // The OS-level prompt (macOS Privacy & Security → Microphone) still
  // gates the actual mic, but at least Electron stops being the wall
  // before the OS gets a say.
  const ALLOWED_PERMS = new Set([
    "media",
    "mediaKeySystem",
    "clipboard-sanitized-write",
  ]);
  session.defaultSession.setPermissionRequestHandler(
    (_wc, permission, callback) => {
      callback(ALLOWED_PERMS.has(permission));
    },
  );
  // The check handler is consulted synchronously by the renderer's
  // Permissions API and by Chromium's media stack before kicking off
  // a getUserMedia. Returning `true` here mirrors the request grant.
  session.defaultSession.setPermissionCheckHandler((_wc, permission) =>
    ALLOWED_PERMS.has(permission),
  );
  // 2026-09-12 — harte Download-Sperre auf allen Sitzungen (Hauptfenster:
  // nur eigene blob:/data:-Exporte; Hintergrund: gar nichts, ausser
  // Handelsregister/Unternehmensregister).
  guardAllKnownSessions(session);
  setDownloadBlockedListener(({ url, host, hintergrund }) =>
    audit({
      actorType: "system",
      actorId: null,
      category: "watch",
      action: "download.blocked",
      severity: "warning",
      subjectType: null,
      subjectId: null,
      summary: `Download blockiert (${hintergrund ? "Hintergrund-Browser" : "Hauptfenster"}): ${host || url.slice(0, 80)}`,
      metadata: { url: url.slice(0, 500), host, hintergrund },
    }),
  );

  // M3 monetization — Stripe Checkout / Customer Portal IPC + the
  // `ava://billing/*` protocol bridge. Registers its own ipcMain
  // handlers for `billing:openCheckout` / `billing:openPortal` and
  // wires `app.on('open-url')` for Stripe success/cancel redirects.
  initBilling({
    gatewayUrl: APP_CONFIG.gatewayUrl,
    getAccessToken: () => auth.getAccessToken(),
  });

  // LinkedIn-Beobachter (Phase L0). Persistent settings + consent gate
  // + kill-switch IPC. No scraper code here yet — that lands in L1+.
  initLinkedIn({
    providers,
    gateway: gatewayClient,
    // v0.1.344 — Profil-Freitext fließt als zusätzliche Stärke-Kriterien
    // in die Signalbewertung. Live gelesen, damit Profil-Edits ab dem
    // nächsten Scan greifen (kein Neustart nötig).
    signalInterests: () => userProfile.get().signalInterests,
  });

  // v0.1.341 — external watchdog sidecar. The wake-hang was proven to be
  // a MAIN-process JS busy-spin (pid alive + STAT=R, 100% of samples in
  // one JIT'd JS stack), so no in-process recovery can fire. This detached
  // Node sidecar watches the heartbeat file from OUTSIDE main's frozen
  // event loop and force-relaunches AVA if the heartbeat stops advancing
  // while the machine is awake. See main/watchdog.ts.
  startWatchdog();

  function focusedWindow(): BrowserWindow | null {
    return (
      BrowserWindow.getFocusedWindow() ??
      BrowserWindow.getAllWindows()[0] ??
      null
    );
  }

  // ---- IPC je Domäne (src/main/ipc/) --------------------------------------
  registerSkillsIpc({ agentRegistry, focusedWindow, skillsPrefs, skillStore, skillsTrust, toSkillRow });
  registerCrmIpc({ auth, crmManager, GATEWAY_URL });
  registerLaufzeitIpc({ externalServiceMonitor, ollama, ollamaUpdater, postgres, producers, storageDeps, updater });
  registerSpracheIpc({ auth, gatewayClient, providers, spracheRelay, spracheStand, spracheStore, userProfile });
  registerRechercheIpc({ producers, providers, researchBundle, researchStore });
  registerStammdatenIpc({ mithelfen: core.mithelfen, registerQueueStatus, workerModusMerkerLoeschen, workerModusMerkerSetzen });
  registerVorschlaegeIpc({ agentRegistry, chipErzeugung: core.chipErzeugung, hintergrundAufgaben, nutzerstand: core.nutzerstand, vorschlaegeSettings: core.vorschlaegeSettings });
  registerPersonenIpc({ apifyZugangInfo, audit, cycleCompanyContact, getTenantTierCached, personenRadarStore: core.personenRadarStore, personenRadarSupervisor: core.personenRadarSupervisor, resolveApifyAccess, watchlistKeyStore: core.watchlistKeyStore, watchlistStore: core.watchlistStore, watchlistSupervisor: core.watchlistSupervisor });
  registerAblaeufeIpc({ wf });
  registerDiscoveryIpc({ agent, audit, customerProfiles, discoveryMatches, gatewayClient, icpAnalysisRunning: core.icpAnalysisRunning, icpStore, profileWorker: core.profileWorker, providers, radarAlertEmitter: core.radarAlertEmitter, radarSupervisor: core.radarSupervisor, userProfile });
  registerKontoIpc({ auth });
  registerRelevanzIpc({ crmManager, gatewayClient });
  registerSystemIpc({ alerts, APP_CONFIG, audit, auth, eigenerBrowser: core.eigenerBrowser, gatewayClient, pendingWakeAcks, statusWatcher });
  registerMailEntwurfIpc({ attachments: core.attachments ?? null });
  registerWissenIpc({ knowledge, knowledgeStore });
  registerVerlaufIpc({ audit, auditStore, auth, broadcastDailyLimitStatus, computeDailyLimitStatus, providers, selfCorrectionsStore, usageStore });
  registerBeobachtungIpc({ audit, broadcastWatchesChanged, linkMonitorSupervisor: core.linkMonitorSupervisor, publicationStore, watchStore });
  registerKommunikationIpc({ audit, broadcastMailSnapshot, emailMuster: core.emailMuster, mailSupervisor: core.mailSupervisor, scheduledJobsSupervisor: core.scheduledJobsSupervisor, telegramSnapshot, telegramStore });
  registerStimmeIpc({ whisper });
  registerMeldungenIpc({ alertPrefs, alerts, broadcastAlertsChanged, freshness, freshnessPrefs, heartbeat, interest, notifications, userProfile });
  registerAgentIpc({ agent, attachments, audit, auth, autonomyStore, generalMemory, memory, memoryProbe, providerConfigStore, providers });
  registerInstanzIpc({ instanz: c.instanz, zustandMelden: () => c.mcpRelais.zustandMelden(), umzug: c.umzug });

  createMainWindow();

  await c.startBackground();

  // Auto-updater. No-op in dev. In packaged builds: checks GitHub
  // Releases on launch + every 4h while the app is open.
  // v0.1.155 — start() became async because it reads a "previous-boot
  // install-attempted" marker before kicking the first check. We
  // intentionally fire-and-forget: the await would block the rest of
  // app.whenReady, and the marker read is best-effort.
  void c.updater.start();

  app.on("activate", () => {
    // v0.1.387 — Dock-Klick / App-Aktivierung: das echte AVA-Hauptfenster
    // nach vorne holen. Vorher prüfte das nur `length === 0` und legte ein
    // neues Fenster an — aber das persistente, unsichtbare LinkedIn-Scraper-
    // Fenster hält die Fensterzahl IMMER > 0, sodass der Klick ins Leere lief
    // und AVA sich nicht aus dem Hintergrund holen ließ. Jetzt suchen wir
    // gezielt das Nicht-Scraper-Fenster, stellen es wieder her und fokussieren.
    const main = getMainAppWindow();
    if (!main) {
      createMainWindow();
      return;
    }
    if (main.isMinimized()) main.restore();
    main.show();
    main.focus();
  });
});


app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// Best-effort graceful shutdown of the child process on quit. Electron
// gives us a small window before SIGKILL — `stop()` issues SIGTERM and
// returns immediately, the OS handles the rest.
//
// v0.1.308 — Auf Windows MÜSSEN die Child-Producers wirklich tot sein
// bevor wir aussteigen, sonst halten sie .exe-Handles im Install-Dir
// und der Uninstaller/Updater scheitert mit "Datei in Verwendung".
// Wir gewähren bis zu 4s, dann gehen wir trotzdem. macOS/Linux müssen
// das nicht warten — dort räumt der Process-Group-Tree von selbst auf.
let quitInProgress = false;
app.on("before-quit", (e) => {
  // Ohne fertige Komposition gibt es nichts zu stoppen (Abbruch im Start).
  const c = core;
  if (!c) return;
  // Beenden-Anzeige: im ersten Durchlauf nur das Overlay zeigen (siehe oben);
  // der Update-Install-Pfad muss trotzdem sofort hart raus.
  if (istQuitAnzeigePhase() && !c.updater.isInstallingUpdate()) return;
  // v0.1.520 — jeder Schritt mit synchroner Breadcrumb (siehe
  // file-logger.quitStep): benennt beim naechsten haengenden Quit den
  // Schritt, in dem der Main-Thread stecken bleibt.
  quitStep("whisper.cancelDownload", () => c.whisper.cancelDownload());
  quitStep("freshness.stop", () => c.freshness.stop());
  quitStep("heartbeat.stop", () => c.heartbeat.stop());
  quitStep("retryTicker.stop", () => c.retryTicker.stop());
  quitStep("agent.dispose", () => c.agent.dispose());
  quitStep("providers.dispose", () => c.providers.dispose());
  quitStep("updater.stop", () => c.updater.stop());
  quitStep("externalServiceMonitor.stop", () => c.externalServiceMonitor.stop());
  quitStep("ollama.stop", () => c.ollama.stop());
  // v0.1.314 — Update-Install-Pfad: NSIS hat den Quit gefeuert. Hier
  // dürfen wir KEINEN graceful Stop machen, weil NSIS bereits versucht
  // .exe-Dateien zu überschreiben, und jeder gehaltene Handle führt
  // zum "AVA kann nicht geschlossen werden"-Dialog. Stattdessen alle
  // Producer SOFORT hart killen und nach 200ms hart raus mit
  // app.exit(0) — der spart das gracefule before-quit-Reentry.
  if (c.updater.isInstallingUpdate()) {
    console.log("[quit] update-install path — force-killing all subprocesses");
    for (const p of c.producers) {
      try {
        p.forceKill();
      } catch {
        /* ignore */
      }
    }
    // v0.1.316 — Ollama MUSS hart sterben, sonst hält der Subprozess
    // <App>/Contents/Resources/ollama/... offen und Squirrel/ShipIt
    // (Mac) bzw. NSIS (Win) blockt beim Bundle-/Folder-Replace. Real-
    // Run-Log v0.1.311→0.1.312 zeigte exakt das: Proxy wird geschlossen,
    // ShipIt startet, aber der Update-Pfad bleibt einfach hängen.
    try {
      c.ollama.forceKill();
    } catch {
      /* ignore */
    }
    // c.postgres ist in-process PGlite, kein externer Prozess; async ok.
    void c.postgres.stop().catch(() => undefined);
    setTimeout(() => app.exit(0), 200);
    return;
  }
  if (process.platform === "win32" && !quitInProgress) {
    // Erst alle stop()-Promises sammeln, mit Deadline awaiten, dann
    // app.quit() erneut feuern (mit quitInProgress=true, damit dieser
    // Handler nicht in eine Schleife läuft).
    e.preventDefault();
    quitInProgress = true;
    const deadline = new Promise<void>((r) => setTimeout(r, 4000));
    const stops = Promise.all(c.producers.map((p) => p.stop().catch(() => undefined)));
    void Promise.race([stops, deadline]).then(async () => {
      await beendeVerwaisteBrowser({ alle: true, log: (z) => writeLineSync("INFO ", z) }).catch(() => undefined);
      void c.postgres.stop();
      app.quit();
    });
    return;
  }
  // Non-Windows: fire-and-forget. Das Betriebssystem raeumt NICHT den ganzen
  // Baum auf: chromedriver und Chrome der Producer blieben als Waisen stehen
  // (Befund 2026-09-16: 110 Prozesse, 2,7 GB). Deshalb nach dem Stop-Signal
  // alle markierten AVA-Browser beenden und die Waisen kurz danach noch einmal.
  quitStep("producers.stop", () => {
    for (const p of c.producers) {
      void p.stop();
    }
    void beendeVerwaisteBrowser({ alle: true, log: (z) => writeLineSync("INFO ", z) });
    setTimeout(() => void beendeVerwaisteBrowser({ alle: true }), 1500);
  });
  // Register-Delta-Worker: Bis 2026-09-18 bekam sein Kindprozess beim App-Ende
  // ueberhaupt kein Signal (docs/ANALYSE_CHROME_PROZESSE.md, D7). Er startet
  // ebenfalls Chrome, und im Worker-Modus laeuft er dauerhaft.
  quitStep("mithelfen.stop", () => c.mithelfen.current?.stop());
  quitStep("postgres.stop", () => c.postgres.stop());
  quitStep("producerLogBuffer.closeRunFiles", () => producerLogBuffer.closeRunFiles());
  writeLineSync("INFO ", "[quit] before-quit handlers done");
});

