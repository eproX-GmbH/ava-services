import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { logger } from "./logger";

// Gateway-side overlay for user-supplied transaction names.
//
// Why this lives in the gateway and not in master-data / company-profile:
//   - The user types the name into the desktop chat composer and it
//     reaches the gateway as a query parameter on POST /v1/imports/excel.
//     master-data accepts it but doesn't currently propagate it through
//     to the company-profile transaction record that backs the read
//     endpoints, so a list call returns rows without `name`.
//   - Owning the annotation at the gateway side is also independent of
//     upstream changes — when master-data eventually persists the name
//     itself, the overlay merge below stays harmless (upstream wins
//     when both sources have a value).
//
// Storage: a JSON object `{ [transactionId]: name }` written atomically
// via temp + rename so a crash mid-write can't strand a half-file.
// One file, gateway-process owned. Multi-replica gateways would need to
// move this into the audit DB (a 2-column Prisma model) — track that as
// a follow-up if/when the gateway runs HA.

const FILE_NAME = "transaction-names.json";
const DATA_DIR =
  process.env.GATEWAY_DATA_DIR ??
  join(process.cwd(), ".gateway-data");

let cache: Record<string, string> | null = null;

function loadCache(): Record<string, string> {
  if (cache !== null) return cache;
  const path = join(DATA_DIR, FILE_NAME);
  if (!existsSync(path)) {
    cache = {};
    return cache;
  }
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      // Filter to string→string entries; tolerate manual edits.
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof k === "string" && typeof v === "string") out[k] = v;
      }
      cache = out;
      return cache;
    }
  } catch (err) {
    logger.warn(
      { err, path },
      "[transaction-names] read failed; falling back to empty map",
    );
  }
  cache = {};
  return cache;
}

function persist(map: Record<string, string>): void {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    const path = join(DATA_DIR, FILE_NAME);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(map, null, 2), { mode: 0o600 });
    renameSync(tmp, path);
  } catch (err) {
    logger.warn({ err }, "[transaction-names] write failed");
  }
}

/**
 * Persist a name for a transaction. Empty / whitespace-only names are
 * treated as "no annotation" and skipped — keeps the file tidy.
 */
export function setTransactionName(
  transactionId: string,
  name: string | null | undefined,
): void {
  const trimmed = (name ?? "").trim();
  if (!transactionId || !trimmed) return;
  const map = { ...loadCache(), [transactionId]: trimmed };
  cache = map;
  persist(map);
}

export function getTransactionName(transactionId: string): string | null {
  const map = loadCache();
  return map[transactionId] ?? null;
}

/**
 * Bulk lookup for the list endpoint. Avoids one disk hit per row — we
 * already have the whole map in memory after the first call.
 */
export function getTransactionNames(
  transactionIds: readonly string[],
): Map<string, string> {
  const map = loadCache();
  const out = new Map<string, string>();
  for (const id of transactionIds) {
    const v = map[id];
    if (v) out.set(id, v);
  }
  return out;
}
