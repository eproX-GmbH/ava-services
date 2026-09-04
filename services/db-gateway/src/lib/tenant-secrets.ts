// O4 — Verschluesselte Ablage der Organisationsschluessel.
//
// AES-256-GCM mit TENANT_SECRETS_KEY (32 Byte, base64). Ciphertext-Format
// `v1.<iv b64url>.<tag b64url>.<data b64url>`. Der Klartext verlaesst den
// Prozess nie: kein Endpunkt liefert ihn, nur der Proxy entschluesselt.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { loadEnv } from "./env";

let cachedKey: Buffer | null | undefined;

export class SecretsUnconfiguredError extends Error {
  constructor() {
    super("TENANT_SECRETS_KEY nicht gesetzt");
  }
}

function masterKey(): Buffer {
  if (cachedKey !== undefined) {
    if (!cachedKey) throw new SecretsUnconfiguredError();
    return cachedKey;
  }
  const raw = loadEnv().TENANT_SECRETS_KEY;
  if (!raw) {
    cachedKey = null;
    throw new SecretsUnconfiguredError();
  }
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== 32) throw new Error("TENANT_SECRETS_KEY muss 32 Byte (base64) sein");
  cachedKey = buf;
  return buf;
}

export function secretsConfigured(): boolean {
  try {
    masterKey();
    return true;
  } catch {
    return false;
  }
}

export function encryptSecret(plain: string, aad: string): string {
  const key = masterKey();
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(aad, "utf8"));
  const data = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  const tag = c.getAuthTag();
  return `v1.${iv.toString("base64url")}.${tag.toString("base64url")}.${data.toString("base64url")}`;
}

export function decryptSecret(ciphertext: string, aad: string): string {
  const key = masterKey();
  const [v, ivB, tagB, dataB] = ciphertext.split(".");
  if (v !== "v1" || !ivB || !tagB || !dataB) throw new Error("ciphertext format");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB, "base64url"));
  d.setAAD(Buffer.from(aad, "utf8"));
  d.setAuthTag(Buffer.from(tagB, "base64url"));
  return Buffer.concat([d.update(Buffer.from(dataB, "base64url")), d.final()]).toString("utf8");
}

export function keyHint(plain: string): string {
  return plain.length >= 4 ? plain.slice(-4) : "****";
}
