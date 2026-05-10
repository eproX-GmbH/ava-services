// LinkedIn-Beobachter session store (Phase L1).
//
// Holds the captured LinkedIn cookies needed by the L2 scraper to spin
// up an authenticated Playwright context. The cookie blob is encrypted
// via Electron's `safeStorage` (OS keychain on macOS / Windows; on
// Linux requires libsecret — falls back to plaintext with a console
// warning when unavailable). Metadata (capture time, earliest expiry,
// best-effort memberUrn) lives unencrypted alongside so the renderer
// can render "Verbunden seit …" without round-tripping through
// safeStorage (which is sync-only and main-only).
//
// All files live under userData/linkedin/, which the L0 kill-switch
// (`store.reset()`) wipes recursively — so this module deliberately
// adds nothing to the kill-switch contract.
//
// IMPORTANT: the cookies themselves are NEVER exposed across the IPC
// boundary. Only main-process code reads them — L1's renderer surface
// returns metadata only, and L2 will read them directly main-side
// when constructing its Playwright context.

import { app, safeStorage } from "electron";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { LinkedInSessionMeta } from "../../shared/types";

function dir(): string {
  return join(app.getPath("userData"), "linkedin");
}

function blobPath(): string {
  return join(dir(), "session.enc");
}

function metaPath(): string {
  return join(dir(), "session.meta.json");
}

function ensureDir(): void {
  const d = dir();
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

/** Best-effort decode of the JWT-ish payload baked into li_at. The
 *  cookie value contains a base64-url segment that, when decoded,
 *  carries a `sub` claim shaped like `urn:li:member:12345`. We catch
 *  every failure mode and return null — the auth flow doesn't depend
 *  on this. */
function decodeMemberUrn(liAt: string | undefined): string | null {
  if (!liAt) return null;
  try {
    // li_at payloads are typically wrapped in quotes by LinkedIn —
    // and contain a `.`-separated JWT-ish triple somewhere inside.
    const stripped = liAt.replace(/^"|"$/g, "");
    const parts = stripped.split(".");
    if (parts.length < 2) return null;
    const payload = parts[1];
    if (!payload) return null;
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    const json = Buffer.from(
      padded.replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    ).toString("utf8");
    const obj = JSON.parse(json) as { sub?: unknown };
    if (typeof obj.sub === "string" && obj.sub.length > 0) return obj.sub;
    return null;
  } catch {
    return null;
  }
}

function deriveMeta(cookies: Electron.Cookie[]): LinkedInSessionMeta {
  let earliest: number | null = null;
  for (const c of cookies) {
    if (typeof c.expirationDate === "number") {
      const ms = Math.round(c.expirationDate * 1000);
      if (earliest === null || ms < earliest) earliest = ms;
    }
  }
  const liAt = cookies.find((c) => c.name === "li_at")?.value;
  return {
    capturedAt: Date.now(),
    earliestExpiresAt: earliest,
    memberUrn: decodeMemberUrn(liAt),
  };
}

export function hasStoredSession(): boolean {
  return existsSync(blobPath()) && existsSync(metaPath());
}

export function readStoredSession(): {
  cookies: Electron.Cookie[];
  meta: LinkedInSessionMeta;
} | null {
  try {
    if (!hasStoredSession()) return null;
    const blob = readFileSync(blobPath());
    let cookiesJson: string;
    if (safeStorage.isEncryptionAvailable()) {
      cookiesJson = safeStorage.decryptString(blob);
    } else {
      cookiesJson = blob.toString("utf8");
    }
    const cookies = JSON.parse(cookiesJson) as Electron.Cookie[];
    const meta = JSON.parse(
      readFileSync(metaPath(), "utf8"),
    ) as LinkedInSessionMeta;
    return { cookies, meta };
  } catch (err) {
    console.warn(
      "[linkedin] readStoredSession failed:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

export function readStoredMeta(): LinkedInSessionMeta | null {
  try {
    if (!existsSync(metaPath())) return null;
    return JSON.parse(readFileSync(metaPath(), "utf8")) as LinkedInSessionMeta;
  } catch (err) {
    console.warn(
      "[linkedin] readStoredMeta failed:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

export function writeStoredSession(
  cookies: Electron.Cookie[],
): LinkedInSessionMeta {
  ensureDir();
  const meta = deriveMeta(cookies);
  const json = JSON.stringify(cookies);
  if (safeStorage.isEncryptionAvailable()) {
    const enc = safeStorage.encryptString(json);
    writeFileSync(blobPath(), enc);
  } else {
    console.warn(
      "[linkedin] safeStorage unavailable — writing session cookies as plaintext.",
    );
    writeFileSync(blobPath(), json, "utf8");
  }
  writeFileSync(metaPath(), JSON.stringify(meta, null, 2), "utf8");
  return meta;
}

export function clearStoredSession(): void {
  for (const p of [blobPath(), metaPath()]) {
    try {
      if (existsSync(p)) rmSync(p, { force: true });
    } catch (err) {
      console.warn(
        "[linkedin] clearStoredSession failed for",
        p,
        ":",
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}
