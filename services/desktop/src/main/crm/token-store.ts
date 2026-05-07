// v0.1.54 — encrypted CRM token persistence.
//
// One file per provider under <userData>/crm/ holding a JSON record
// with the metadata + an opaque encrypted blob. Encryption uses
// Electron's safeStorage — backed by macOS Keychain, Windows DPAPI,
// or Linux libsecret. If safeStorage refuses to encrypt (rare; some
// Linux setups without a keyring) we don't store at all — the
// connection becomes "not connected" and the user re-runs OAuth.
//
// Layout chosen over a single multi-record file:
//   - Per-provider lock semantics are simpler (one writer at a time
//     per file).
//   - Corrupt/incompatible token from one provider doesn't taint the
//     other two.
//   - Easier to manually inspect/delete a single CRM during dev.

import { app, safeStorage } from "electron";
import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CrmProvider, CrmStoredRecord, CrmTokens } from "./types";
import { CRM_PROVIDERS } from "./types";

function dir(): string {
  return join(app.getPath("userData"), "crm");
}

function fileFor(provider: CrmProvider): string {
  return join(dir(), `${provider}.json`);
}

/** Persist tokens + account metadata. Caller has just completed a
 *  successful OAuth exchange (or refresh). Idempotent. */
export async function saveTokens(
  provider: CrmProvider,
  account: string,
  tokens: CrmTokens,
): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    // Rare on macOS / Windows; can happen on bare Linux without
    // libsecret. Skip persistence — the in-memory tokens still work
    // for this session, but a restart will require re-connect.
    return;
  }
  await fs.mkdir(dir(), { recursive: true });
  const encryptedTokens = safeStorage
    .encryptString(JSON.stringify(tokens))
    .toString("base64");
  const record: CrmStoredRecord = {
    provider,
    account,
    lastRefreshedAt: new Date().toISOString(),
    encryptedTokens,
  };
  await fs.writeFile(fileFor(provider), JSON.stringify(record), {
    mode: 0o600,
  });
}

/** Read tokens. Returns null if not connected, encryption is
 *  unavailable, or the on-disk record is corrupt. */
export async function loadTokens(
  provider: CrmProvider,
): Promise<{ account: string; tokens: CrmTokens; lastRefreshedAt: string } | null> {
  if (!safeStorage.isEncryptionAvailable()) return null;
  const path = fileFor(provider);
  if (!existsSync(path)) return null;
  try {
    const raw = await fs.readFile(path, "utf8");
    const record = JSON.parse(raw) as CrmStoredRecord;
    const tokensRaw = safeStorage.decryptString(
      Buffer.from(record.encryptedTokens, "base64"),
    );
    const tokens = JSON.parse(tokensRaw) as CrmTokens;
    return {
      account: record.account,
      tokens,
      lastRefreshedAt: record.lastRefreshedAt,
    };
  } catch {
    // Corrupt record — wipe so the user can re-connect cleanly.
    await fs.unlink(path).catch(() => undefined);
    return null;
  }
}

/** Drop tokens for a provider — used on disconnect, or when a
 *  refresh-token rejection signals the user revoked at the IdP. */
export async function clearTokens(provider: CrmProvider): Promise<void> {
  await fs.unlink(fileFor(provider)).catch(() => undefined);
}

/** Bulk read for the "list all CRM connections" path (Settings + the
 *  agent's `get_crm_status` tool). Always returns one entry per
 *  provider so the renderer can render a card for unconnected ones. */
export async function loadAllStored(): Promise<
  Record<CrmProvider, { account: string; lastRefreshedAt: string } | null>
> {
  const out = {} as Record<
    CrmProvider,
    { account: string; lastRefreshedAt: string } | null
  >;
  for (const p of CRM_PROVIDERS) {
    const rec = await loadTokens(p);
    out[p] = rec
      ? { account: rec.account, lastRefreshedAt: rec.lastRefreshedAt }
      : null;
  }
  return out;
}
