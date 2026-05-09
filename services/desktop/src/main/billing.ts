// M3 monetization (v0.1.73) — main-process side.
//
// Two responsibilities:
//   1. Open Stripe Checkout / Customer Portal in the user's default
//      browser. The renderer asks via IPC (`billing:openCheckout` /
//      `billing:openPortal`); we call the gateway with the user's
//      bearer, get the one-shot URL, and `shell.openExternal` it.
//      We deliberately don't keep a BrowserWindow open for billing —
//      Stripe's Checkout / Portal explicitly recommend the system
//      browser for the same RFC 8252 reasons we use it for OAuth
//      (existing session, real URL bar, no embedded webview blocks).
//
//   2. Custom-protocol bridge: Stripe redirects the user's browser
//      to `ava://billing/success?session_id=…` (or `…/cancel`) on
//      checkout finish. The OS opens the AVA app via the registered
//      URL scheme; we surface a `billing:success` IPC event so the
//      renderer can invalidate the `["usage"]` query and the new tier
//      appears without polling.
//
// The gateway URL + auth handle are passed in by main/index.ts at
// boot to keep this module decoupled from APP_CONFIG.

import { app, BrowserWindow, ipcMain, shell } from "electron";

interface BillingDeps {
  gatewayUrl: string;
  getAccessToken: () => Promise<string | null>;
}

let deps: BillingDeps | null = null;

export function initBilling(d: BillingDeps): void {
  deps = d;

  // ---- IPC ----------------------------------------------------------------

  ipcMain.handle(
    "billing:openCheckout",
    async (_e, tier: "starter" | "pro") => {
      const url = await fetchBillingUrl("/v1/billing/checkout", { tier });
      await shell.openExternal(url);
    },
  );

  ipcMain.handle("billing:openPortal", async () => {
    const url = await fetchBillingUrl("/v1/billing/portal", {});
    await shell.openExternal(url);
  });

  // ---- Custom protocol ----------------------------------------------------

  // Register `ava://` so the OS opens our app on Stripe redirects. On
  // macOS this delivers via `open-url`; on Windows / Linux the URL is
  // an extra argv entry on a second-instance launch (handled below).
  // `setAsDefaultProtocolClient` is idempotent — safe to call again.
  if (!app.isDefaultProtocolClient("ava")) {
    app.setAsDefaultProtocolClient("ava");
  }

  app.on("open-url", (event, url) => {
    event.preventDefault();
    handleAvaUrl(url);
  });

  // Single-instance lock so a second launch (Windows / Linux protocol
  // delivery) routes back into this process. main/index.ts may also
  // request this lock; calling it here is idempotent.
  app.on("second-instance", (_e, argv) => {
    const protoArg = argv.find((a) => a.startsWith("ava://"));
    if (protoArg) handleAvaUrl(protoArg);
  });
}

async function fetchBillingUrl(
  path: string,
  body: Record<string, unknown>,
): Promise<string> {
  if (!deps) throw new Error("billing not initialized");
  const token = await deps.getAccessToken();
  if (!token) throw new Error("not signed in");
  const url = new URL(path, deps.gatewayUrl).toString();
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = undefined;
  try { parsed = text ? JSON.parse(text) : undefined; } catch { /* ignore */ }
  if (!res.ok) {
    const msg =
      typeof parsed === "object" && parsed && "message" in parsed
        ? String((parsed as { message: unknown }).message)
        : `gateway ${res.status}`;
    throw new Error(msg);
  }
  const u = (parsed as { url?: string } | undefined)?.url;
  if (!u) throw new Error("gateway response missing url");
  return u;
}

function handleAvaUrl(raw: string): void {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return;
  }
  if (parsed.protocol !== "ava:") return;
  // ava://billing/success | ava://billing/cancel | ava://billing/upgrade
  // URL parses host="billing", pathname="/success" etc.
  if (parsed.host !== "billing") return;

  const path = parsed.pathname.replace(/^\/+/, "");
  if (path === "success" || path === "portal-return") {
    // Bring the app forward and notify the renderer. The success page
    // lands here; cancel needs no renderer action (modal stays as-is).
    focusApp();
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("billing:success");
    }
  } else if (path === "cancel") {
    focusApp();
  } else if (path === "upgrade") {
    // The gateway's 402 payload includes `upgradeUrl: ava://billing/upgrade`
    // as a hint; if a user ever clicks it from outside the app it should
    // just bring the window to front. The Settings → Plan section is
    // already where the upgrade buttons live.
    focusApp();
  }
}

function focusApp(): void {
  try {
    app.focus({ steal: true });
    const wins = BrowserWindow.getAllWindows();
    if (wins.length > 0) {
      const w = wins[0]!;
      if (w.isMinimized()) w.restore();
      w.show();
      w.focus();
    }
  } catch {
    // cosmetic only
  }
}
