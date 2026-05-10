// LinkedIn-Beobachter login window (Phase L1).
//
// Opens an embedded BrowserWindow pointed at https://www.linkedin.com/login
// in an isolated session partition. The user logs into LinkedIn directly
// (we never touch the credentials). When navigation crosses into
// authenticated territory (/feed, /in/, /home) we capture the session
// cookies, encrypt + persist them via session.ts, and resolve.
//
// Design notes:
//  - Partition: `persist:linkedin`. Isolated from the main app session
//    so neither side leaks state. The L2 scraper does NOT reuse this
//    partition — it reads the persisted cookies back into a fresh
//    Playwright context. That keeps the auth surface narrow and gives
//    us a single source of truth (the encrypted blob).
//  - We clear the partition's cookie store before navigating so a
//    stale captcha cookie can't trip up the live scrape later.
//  - We listen on both `did-navigate` (top-level) and
//    `did-redirect-navigation` (server redirects) — LinkedIn sometimes
//    redirects post-login through several intermediate pages and we
//    want to grab the cookies on the first authenticated hop.
//  - LinkedIn occasionally serves a "verify it's you" challenge before
//    issuing li_at. Our window stays open through that — we only
//    resolve when the URL crosses into an authenticated path.
//  - If the user clicks an external link (e.g. forgot-password Google
//    flow) we DO NOT close the window. Only authenticated linkedin.com
//    paths trigger capture.
//  - 5-minute hard timeout (covers 2FA / device verification with
//    plenty of slack).
//  - No preload script. LinkedIn runs as itself in the embedded view.

import { BrowserWindow, session } from "electron";
import {
  clearStoredSession,
  writeStoredSession,
} from "./session";
import type { LinkedInSessionMeta } from "../../shared/types";

const PARTITION = "persist:linkedin";
const LOGIN_URL = "https://www.linkedin.com/login";
const TIMEOUT_MS = 5 * 60 * 1000;

const RELEVANT_COOKIE_NAMES = new Set([
  "li_at",
  "JSESSIONID",
  "li_rm",
  "lidc",
  "bcookie",
  "bscookie",
  "lang",
  "li_mc",
]);

function isAuthenticatedPath(urlString: string): boolean {
  try {
    const u = new URL(urlString);
    if (u.hostname !== "www.linkedin.com") return false;
    return (
      u.pathname === "/feed" ||
      u.pathname === "/feed/" ||
      u.pathname.startsWith("/feed/") ||
      u.pathname.startsWith("/in/") ||
      u.pathname === "/home" ||
      u.pathname.startsWith("/home/")
    );
  } catch {
    return false;
  }
}

async function clearPartitionCookies(): Promise<void> {
  const part = session.fromPartition(PARTITION);
  try {
    await part.cookies.flushStore();
    const all = await part.cookies.get({});
    await Promise.all(
      all.map((c) => {
        // The Cookies.remove API needs a URL; reconstruct one from
        // domain + path. Strip a leading dot so it parses cleanly.
        const host = c.domain?.replace(/^\./, "") ?? "";
        const protocol = c.secure ? "https://" : "http://";
        const url = `${protocol}${host}${c.path ?? "/"}`;
        return part.cookies.remove(url, c.name).catch(() => undefined);
      }),
    );
    await part.cookies.flushStore();
  } catch (err) {
    console.warn(
      "[linkedin] clearPartitionCookies failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

async function readRelevantCookies(): Promise<Electron.Cookie[]> {
  const part = session.fromPartition(PARTITION);
  // Pull cookies for both apex and www; merge by (name, domain).
  const a = await part.cookies.get({ url: "https://www.linkedin.com" });
  const b = await part.cookies.get({ url: "https://linkedin.com" });
  const seen = new Map<string, Electron.Cookie>();
  for (const c of [...a, ...b]) {
    if (!RELEVANT_COOKIE_NAMES.has(c.name)) continue;
    seen.set(`${c.name}|${c.domain ?? ""}`, c);
  }
  return Array.from(seen.values());
}

export async function runLoginFlow(
  parent: BrowserWindow | null,
): Promise<
  | { ok: true; meta: LinkedInSessionMeta }
  | { ok: false; reason: "user_cancelled" | "no_cookies" | "timeout" }
> {
  // Always start from a clean slate: stale captcha cookies in the
  // partition can otherwise cause LinkedIn to short-circuit the login
  // page and skip cookie issuance.
  await clearPartitionCookies();
  // Drop any prior persisted blob too — we're explicitly starting a
  // fresh login attempt.
  clearStoredSession();

  const win = new BrowserWindow({
    width: 480,
    height: 720,
    parent: parent ?? undefined,
    modal: parent !== null,
    autoHideMenuBar: true,
    title: "LinkedIn-Anmeldung",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: PARTITION,
    },
  });

  return await new Promise((resolve) => {
    let settled = false;
    let capturing = false;

    const finish = (
      result:
        | { ok: true; meta: LinkedInSessionMeta }
        | { ok: false; reason: "user_cancelled" | "no_cookies" | "timeout" },
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        if (!win.isDestroyed()) win.close();
      } catch {
        /* ignore */
      }
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({ ok: false, reason: "timeout" });
    }, TIMEOUT_MS);

    const handleNavigation = async (url: string) => {
      if (settled || capturing) return;
      if (!isAuthenticatedPath(url)) return;
      capturing = true;
      try {
        const cookies = await readRelevantCookies();
        const hasLiAt = cookies.some((c) => c.name === "li_at");
        if (!hasLiAt) {
          // Authenticated path but no li_at yet — let LinkedIn settle
          // and try once more on the next navigation event.
          capturing = false;
          return;
        }
        const meta = writeStoredSession(cookies);
        finish({ ok: true, meta });
      } catch (err) {
        console.warn(
          "[linkedin] cookie capture failed:",
          err instanceof Error ? err.message : String(err),
        );
        capturing = false;
      }
    };

    win.webContents.on("did-navigate", (_e, url) => {
      void handleNavigation(url);
    });
    win.webContents.on("did-redirect-navigation", (_e, url) => {
      void handleNavigation(url);
    });

    win.on("closed", () => {
      finish({ ok: false, reason: "user_cancelled" });
    });

    win.loadURL(LOGIN_URL).catch((err) => {
      console.warn(
        "[linkedin] login window load failed:",
        err instanceof Error ? err.message : String(err),
      );
      finish({ ok: false, reason: "no_cookies" });
    });
  });
}
