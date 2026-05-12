// Phase A6 — In-App-OAuth-Flow für die Claude.ai-Subscription.
//
// Öffnet ein dediziertes `BrowserWindow`, lädt den Anthropic-Authorize-
// Endpunkt und fängt die Redirect-URL ab, bevor die Code-Anzeige-Seite
// geladen wird. Der Code wird per PKCE gegen ein Access-Token getauscht
// und an den Aufrufer zurückgegeben.
//
// Bewusst KEIN BrowserView/HiddenView: ein eigenständiges Fenster passt
// besser zu dem, was Nutzer von „Login mit X"-Flows kennen, und die
// Schließen-Geste deckt den Abbruch-Fall ohne weitere UI ab.
//
// Session-Isolation: `partition: 'persist:anthropic-oauth'` legt
// Cookies + LocalStorage des Logins in eine eigene Session, getrennt
// vom Renderer-Default und vom System-Browser des Nutzers. Macht
// gleichzeitig schnellere Re-Logins möglich, falls der Nutzer in der
// laufenden AVA-Session den Token später neu erzeugen will.

import { BrowserWindow, session, type Event as ElectronEvent } from "electron";
import {
  buildAuthorizationUrl,
  exchangeCodeForToken,
  generatePkce,
  type TokenResult,
} from "./anthropic-oauth";

const OAUTH_SESSION_PARTITION = "persist:anthropic-oauth";
const OAUTH_TIMEOUT_MS = 5 * 60 * 1000; // 5 Minuten
const CALLBACK_URL_PREFIX =
  "https://console.anthropic.com/oauth/code/callback";

/**
 * Vollständiger Login-Flow. Resolved mit dem Token, sobald der
 * Code-Exchange durch ist. Rejected (mit deutschem Fehlertext) bei
 * Abbruch, Timeout, Netzwerkfehler oder State-Mismatch.
 *
 * Hinweis: Wir hängen den Login-Renderer NICHT als modales Child-Window
 * an das Main-Fenster — `modal: true` blockiert auf macOS das Eltern-
 * Fenster und verhindert, dass der Nutzer parallel die App weiternutzt,
 * wenn er sich mittendrin umentscheidet. `parent` setzen wir trotzdem,
 * damit Window-Z-Order und Dock-Verhalten stimmen.
 */
export async function runAnthropicOAuth(opts?: {
  parent?: BrowserWindow | null;
}): Promise<TokenResult> {
  const pkce = generatePkce();
  const authUrl = buildAuthorizationUrl(pkce);

  // Eigene Session vorab anlegen, damit wir sie im Cleanup-Pfad gezielt
  // wegräumen können. `fromPartition` ist idempotent.
  session.fromPartition(OAUTH_SESSION_PARTITION);

  const parent = opts?.parent ?? null;
  const win = new BrowserWindow({
    width: 580,
    height: 720,
    resizable: true,
    modal: false,
    ...(parent ? { parent } : {}),
    autoHideMenuBar: true,
    title: "Mit Claude.ai verbinden",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      partition: OAUTH_SESSION_PARTITION,
    },
  });

  return new Promise<TokenResult>((resolve, reject) => {
    // Tracks ob wir den Redirect schon abgefangen haben. Ohne dieses
    // Flag würde der nachgelagerte `closed`-Handler fälschlich
    // „Anmeldung abgebrochen" werfen, obwohl wir das Fenster gerade
    // selbst nach erfolgreichem Code-Empfang schließen.
    let captured = false;
    let settled = false;
    let timeoutHandle: NodeJS.Timeout | null = null;

    const finish = (
      verdict:
        | { ok: true; token: TokenResult }
        | { ok: false; error: Error },
    ): void => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
      try {
        if (!win.isDestroyed()) {
          win.destroy();
        }
      } catch {
        // ignore — Fenster ist bereits weg.
      }
      // Session-Cookies absichtlich NICHT global wegwerfen — eine
      // erneute Login-Runde innerhalb derselben App-Session ist sonst
      // unnötig langsam. Beim nächsten App-Start sind die Cookies
      // ohnehin in der Partition isoliert und für AVA selbst nicht
      // sichtbar.
      if (verdict.ok) resolve(verdict.token);
      else reject(verdict.error);
    };

    const handleNavigation = (event: ElectronEvent, url: string): void => {
      if (!url.startsWith(CALLBACK_URL_PREFIX)) return;
      // Ab hier handhaben wir den Redirect selbst. Wir verhindern die
      // Navigation, damit die Code-Anzeige-Seite nicht kurz aufblitzt.
      event.preventDefault();
      captured = true;

      let code: string | null = null;
      let state: string | null = null;
      try {
        const parsed = new URL(url);
        code = parsed.searchParams.get("code");
        state = parsed.searchParams.get("state");
      } catch {
        // ignore — fällt in die folgende Validierung
      }

      if (!code) {
        finish({
          ok: false,
          error: new Error(
            "Anmeldung fehlgeschlagen — Anthropic-Redirect enthielt keinen Code.",
          ),
        });
        return;
      }
      if (!state || state !== pkce.state) {
        finish({
          ok: false,
          error: new Error(
            "Sicherheitsprüfung fehlgeschlagen. Versuch's nochmal.",
          ),
        });
        return;
      }

      // Code-Exchange in der Main-Task-Queue — wir halten das
      // BrowserWindow bis dahin offen, falls Anthropic eine Folge-
      // Navigation auslöst (sieht man manchmal nach 200-Antworten).
      exchangeCodeForToken({ code, verifier: pkce.verifier, state })
        .then((token) => finish({ ok: true, token }))
        .catch((err: unknown) => {
          const status = (err as { status?: number } | null)?.status;
          let message: string;
          if (status === 401 || status === 403) {
            message =
              "Anthropic hat die Anmeldung abgelehnt. Falls du keinen Claude-Pro/Max/Team-Account hast, klappt's nicht. Versuch's mit einem API-Schlüssel.";
          } else if (typeof status === "number" && status >= 500) {
            message =
              "Anthropic ist gerade nicht erreichbar. Versuch's gleich nochmal.";
          } else if (err instanceof Error) {
            message = err.message;
          } else {
            message = String(err);
          }
          finish({ ok: false, error: new Error(message) });
        });
    };

    win.webContents.on("will-redirect", handleNavigation);
    win.webContents.on("will-navigate", handleNavigation);

    win.webContents.on(
      "did-fail-load",
      (_evt, errorCode, errorDescription, validatedURL) => {
        // -3 = ERR_ABORTED — passiert genau dann, wenn wir den
        // Callback-Redirect per `preventDefault` abbrechen. Das ist
        // erwartet und KEIN Fehlerfall.
        if (errorCode === -3) return;
        if (captured) return;
        console.warn(
          "[anthropic-oauth-flow] did-fail-load:",
          errorCode,
          errorDescription,
          validatedURL,
        );
        finish({
          ok: false,
          error: new Error(
            `Netzwerk-Fehler beim Verbinden mit Anthropic (${errorDescription || errorCode}).`,
          ),
        });
      },
    );

    win.on("closed", () => {
      if (captured || settled) return;
      finish({
        ok: false,
        error: new Error(
          "Du hast das Anmelde-Fenster geschlossen. Versuch's nochmal oder hinterlege den Token manuell.",
        ),
      });
    });

    timeoutHandle = setTimeout(() => {
      if (captured || settled) return;
      finish({
        ok: false,
        error: new Error(
          "Anmeldung dauerte zu lange (>5 Minuten). Versuch's nochmal.",
        ),
      });
    }, OAUTH_TIMEOUT_MS);

    win.loadURL(authUrl).catch((err: unknown) => {
      finish({
        ok: false,
        error: new Error(
          `Netzwerk-Fehler beim Verbinden mit Anthropic: ${err instanceof Error ? err.message : String(err)}`,
        ),
      });
    });
  });
}
