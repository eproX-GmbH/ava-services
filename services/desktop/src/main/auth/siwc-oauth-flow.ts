// Anmelde-Fenster fuer „Sign in with ChatGPT“ (docs/PLAN_SIGN_IN_WITH_CHATGPT.md).
//
// Ein Electron-BrowserWindow laedt die Authorize-Seite; den Redirect auf
// den Loopback faengt
// `will-redirect`/`will-navigate` ab, BEVOR er an einen Port geht. Darum
// braucht es keinen lokalen HTTP-Server (Regel: neue Server nur
// 127.0.0.1 — hier gar keiner). Der Rest ist der dokumentierte Ablauf:
// Erstanmeldung mit dynamischer Client-ID, ausgegebene oaiapp_-ID
// speichern, Code gegen Tokens tauschen, Plan-Scope pruefen.

import { BrowserWindow, session, type Event as ElectronEvent } from "electron";
import {
  SIWC_REDIRECT_URI,
  buildSiwcAuthorizationUrl,
  exchangeSiwcCode,
  generateSiwcPkce,
  hatPlanScope,
  istAusgegebeneClientId,
  parseSiwcCallback,
  type SiwcTokenResult,
} from "./siwc-oauth";

const OAUTH_SESSION_PARTITION = "persist:openai-oauth";
const OAUTH_TIMEOUT_MS = 5 * 60 * 1000;

export interface SiwcLoginErgebnis extends SiwcTokenResult {
  clientId: string;
  planScope: boolean;
}

export async function runSiwcOAuth(opts: {
  hostId: string;
  /** Gespeicherte Client-ID dieser Installation; fehlt sie: Erstanmeldung. */
  clientId?: string | null;
  idTokenHint?: string | null;
  loginHint?: string | null;
  parent?: BrowserWindow | null;
}): Promise<SiwcLoginErgebnis> {
  const pkce = generateSiwcPkce();
  const authUrl = buildSiwcAuthorizationUrl({
    pkce,
    hostId: opts.hostId,
    clientId: opts.clientId ?? null,
    idTokenHint: opts.idTokenHint ?? null,
    loginHint: opts.loginHint ?? null,
  });
  session.fromPartition(OAUTH_SESSION_PARTITION);
  const parent = opts.parent ?? null;
  const win = new BrowserWindow({
    width: 580,
    height: 760,
    resizable: true,
    modal: false,
    ...(parent ? { parent } : {}),
    autoHideMenuBar: true,
    title: "Continue with ChatGPT",
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, partition: OAUTH_SESSION_PARTITION },
  });

  return new Promise<SiwcLoginErgebnis>((resolve, reject) => {
    let captured = false;
    let settled = false;
    let timeoutHandle: NodeJS.Timeout | null = null;
    const finish = (verdict: { ok: true; ergebnis: SiwcLoginErgebnis } | { ok: false; error: Error }): void => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      try {
        if (!win.isDestroyed()) win.destroy();
      } catch {
        /* Fenster bereits weg */
      }
      if (verdict.ok) resolve(verdict.ergebnis);
      else reject(verdict.error);
    };

    const handleNavigation = (event: ElectronEvent, url: string): void => {
      if (!url.startsWith(SIWC_REDIRECT_URI)) return;
      event.preventDefault();
      captured = true;
      const cb = parseSiwcCallback(url);
      if (cb.error) {
        finish({
          ok: false,
          error: new Error(
            cb.error === "access_denied"
              ? "Du hast die Anmeldung abgebrochen oder die Plan-Nutzung nicht freigegeben."
              : `ChatGPT hat die Anmeldung abgelehnt: ${cb.error}`,
          ),
        });
        return;
      }
      if (!cb.code) {
        finish({ ok: false, error: new Error("Anmeldung fehlgeschlagen: Der Redirect enthielt keinen Code.") });
        return;
      }
      if (!cb.state || cb.state !== pkce.state) {
        finish({ ok: false, error: new Error("Sicherheitsprüfung fehlgeschlagen. Versuch's nochmal.") });
        return;
      }
      // Client-ID: bei der Erstanmeldung kommt sie im Callback; sonst gilt
      // die gespeicherte. Eine abweichende neue ID wird nicht uebernommen.
      let clientId: string | null = opts.clientId ?? null;
      if (istAusgegebeneClientId(cb.clientId)) {
        if (clientId && clientId !== cb.clientId) {
          finish({ ok: false, error: new Error("ChatGPT hat eine andere Client-ID zurückgegeben als gespeichert. Bitte trennen und neu verbinden.") });
          return;
        }
        clientId = cb.clientId;
      }
      if (!clientId) {
        finish({ ok: false, error: new Error("ChatGPT hat keine Client-ID für diese Installation ausgegeben.") });
        return;
      }
      const festeClientId = clientId;
      exchangeSiwcCode({ code: cb.code, verifier: pkce.verifier, clientId: festeClientId })
        .then((token) => {
          const scope = token.scope ?? cb.scope ?? "";
          finish({ ok: true, ergebnis: { ...token, scope, clientId: festeClientId, planScope: hatPlanScope(scope) } });
        })
        .catch((err: unknown) => {
          const status = (err as { status?: number } | null)?.status;
          let message: string;
          if (status === 401 || status === 403) message = "ChatGPT hat die Anmeldung abgelehnt. Plan-Nutzung gibt es nur mit ChatGPT Plus oder Pro.";
          else if (typeof status === "number" && status >= 500) message = "OpenAI ist gerade nicht erreichbar. Versuch's gleich nochmal.";
          else message = err instanceof Error ? err.message : String(err);
          finish({ ok: false, error: new Error(message) });
        });
    };

    win.webContents.on("will-redirect", handleNavigation);
    win.webContents.on("will-navigate", handleNavigation);
    win.webContents.on("did-fail-load", (_evt, errorCode, errorDescription, validatedURL) => {
      if (errorCode === -3) return;
      if (captured) return;
      if (validatedURL.startsWith(SIWC_REDIRECT_URI)) return;
      console.warn("[siwc-oauth-flow] did-fail-load:", errorCode, errorDescription, validatedURL);
      finish({ ok: false, error: new Error(`Netzwerk-Fehler beim Verbinden mit ChatGPT (${errorDescription || errorCode}).`) });
    });
    win.on("closed", () => {
      if (captured || settled) return;
      finish({ ok: false, error: new Error("Du hast das Anmelde-Fenster geschlossen. Versuch's nochmal.") });
    });
    timeoutHandle = setTimeout(() => {
      if (captured || settled) return;
      finish({ ok: false, error: new Error("Die Anmeldung hat zu lange gedauert. Versuch's nochmal.") });
    }, OAUTH_TIMEOUT_MS);

    void win.loadURL(authUrl);
  });
}
