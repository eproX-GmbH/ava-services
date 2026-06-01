// v0.1.353 — In-App-OAuth-Flow für die ChatGPT-Subscription.
//
// Pendant zu `anthropic-oauth-flow.ts`. Öffnet ein dediziertes
// `BrowserWindow`, lädt OpenAIs Authorize-Endpunkt und fängt die
// Redirect-Navigation auf `http://localhost:1455/auth/callback` ab,
// bevor sie an einen (nicht existierenden) lokalen Server geht. Der
// Code wird per PKCE gegen Access-/Refresh-Token getauscht; die
// ChatGPT-Account-ID extrahieren wir aus dem id_token-JWT.

import { BrowserWindow, session, type Event as ElectronEvent } from "electron";
import {
  buildAuthorizationUrl,
  exchangeCodeForToken,
  generatePkce,
  OPENAI_OAUTH_REDIRECT_URI,
  type OpenAITokenResult,
} from "./openai-oauth";

const OAUTH_SESSION_PARTITION = "persist:openai-oauth";
const OAUTH_TIMEOUT_MS = 5 * 60 * 1000; // 5 Minuten
const CALLBACK_URL_PREFIX = OPENAI_OAUTH_REDIRECT_URI;

export async function runOpenAIOAuth(opts?: {
  parent?: BrowserWindow | null;
}): Promise<OpenAITokenResult> {
  const pkce = generatePkce();
  const authUrl = buildAuthorizationUrl(pkce);

  session.fromPartition(OAUTH_SESSION_PARTITION);

  const parent = opts?.parent ?? null;
  const win = new BrowserWindow({
    width: 580,
    height: 760,
    resizable: true,
    modal: false,
    ...(parent ? { parent } : {}),
    autoHideMenuBar: true,
    title: "Mit ChatGPT verbinden",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      partition: OAUTH_SESSION_PARTITION,
    },
  });

  return new Promise<OpenAITokenResult>((resolve, reject) => {
    let captured = false;
    let settled = false;
    let timeoutHandle: NodeJS.Timeout | null = null;

    const finish = (
      verdict:
        | { ok: true; token: OpenAITokenResult }
        | { ok: false; error: Error },
    ): void => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
      try {
        if (!win.isDestroyed()) win.destroy();
      } catch {
        /* Fenster bereits weg */
      }
      if (verdict.ok) resolve(verdict.token);
      else reject(verdict.error);
    };

    const handleNavigation = (event: ElectronEvent, url: string): void => {
      if (!url.startsWith(CALLBACK_URL_PREFIX)) return;
      event.preventDefault();
      captured = true;

      let code: string | null = null;
      let state: string | null = null;
      let oauthError: string | null = null;
      try {
        const parsed = new URL(url);
        code = parsed.searchParams.get("code");
        state = parsed.searchParams.get("state");
        oauthError = parsed.searchParams.get("error");
      } catch {
        /* fällt in die folgende Validierung */
      }

      if (oauthError) {
        finish({
          ok: false,
          error: new Error(`OpenAI hat die Anmeldung abgelehnt: ${oauthError}`),
        });
        return;
      }
      if (!code) {
        finish({
          ok: false,
          error: new Error(
            "Anmeldung fehlgeschlagen — OpenAI-Redirect enthielt keinen Code.",
          ),
        });
        return;
      }
      if (!state || state !== pkce.state) {
        finish({
          ok: false,
          error: new Error("Sicherheitsprüfung fehlgeschlagen. Versuch's nochmal."),
        });
        return;
      }

      exchangeCodeForToken({ code, verifier: pkce.verifier })
        .then((token) => finish({ ok: true, token }))
        .catch((err: unknown) => {
          const status = (err as { status?: number } | null)?.status;
          let message: string;
          if (status === 401 || status === 403) {
            message =
              "OpenAI hat die Anmeldung abgelehnt. Falls du kein ChatGPT-Plus/Pro/Team-Abo hast, klappt's nicht. Versuch's mit einem API-Schlüssel.";
          } else if (typeof status === "number" && status >= 500) {
            message = "OpenAI ist gerade nicht erreichbar. Versuch's gleich nochmal.";
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
        // -3 = ERR_ABORTED — passiert wenn wir den Callback-Redirect per
        // preventDefault abbrechen. Erwartet, KEIN Fehler. Außerdem
        // schlägt die Navigation auf localhost:1455 mit
        // ERR_CONNECTION_REFUSED (-102) fehl, falls der Redirect doch
        // durchrutscht, bevor wir ihn fangen — dann haben wir den Code
        // aber schon via handleNavigation. Solange `captured`, ignorieren.
        if (errorCode === -3) return;
        if (captured) return;
        if (validatedURL.startsWith(CALLBACK_URL_PREFIX)) return;
        console.warn(
          "[openai-oauth-flow] did-fail-load:",
          errorCode,
          errorDescription,
          validatedURL,
        );
        finish({
          ok: false,
          error: new Error(
            `Netzwerk-Fehler beim Verbinden mit OpenAI (${errorDescription || errorCode}).`,
          ),
        });
      },
    );

    win.on("closed", () => {
      if (captured || settled) return;
      finish({
        ok: false,
        error: new Error(
          "Du hast das Anmelde-Fenster geschlossen. Versuch's nochmal.",
        ),
      });
    });

    timeoutHandle = setTimeout(() => {
      if (captured || settled) return;
      finish({
        ok: false,
        error: new Error("Anmeldung dauerte zu lange (>5 Minuten). Versuch's nochmal."),
      });
    }, OAUTH_TIMEOUT_MS);

    win.loadURL(authUrl).catch((err: unknown) => {
      finish({
        ok: false,
        error: new Error(
          `Netzwerk-Fehler beim Verbinden mit OpenAI: ${err instanceof Error ? err.message : String(err)}`,
        ),
      });
    });
  });
}
