// „Sign in with ChatGPT“ mit Plan-Nutzung (docs/PLAN_SIGN_IN_WITH_CHATGPT.md).
//
// Offizieller Flow fuer lokal gehostete Apps (developers.openai.com/siwc):
//   * Erste Anmeldung mit `client_id=dynamic_agent_client`, dazu eine
//     stabile Installations-ID (`ext_agent_host_id`, urn:uuid) und der
//     App-Name (`agent_name_hint`). Der Callback bringt eine eigene
//     `oaiapp_…`-Client-ID zurueck, die fuer alle weiteren Anmeldungen und
//     Refreshes dieser Installation gilt.
//   * Authorization-Code + PKCE S256, `state` und `nonce`.
//   * Redirect auf 127.0.0.1 (nicht localhost), Pfad /auth/callback.
//   * Scopes: Identitaet + offline_access + resource.invoke +
//     chatgpt.tokens.use.direct. Plan-Nutzung gibt es NUR, wenn die
//     Token-Antwort den letzten Scope enthaelt.
//   * Access-Token 1 h, Refresh-Token 30 Tage rollierend.
//
// Der fruehere Codex-Umweg (chatgpt.com/backend-api) ist seit v0.1.770
// entfernt; Altbestand raeumt der Store beim Lesen weg.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const SIWC_AUTHORIZE_URL = "https://auth.openai.com/api/accounts/authorize";
export const SIWC_TOKEN_URL = "https://auth.openai.com/api/accounts/oauth/token";
export const SIWC_RESOURCE = "https://api.openai.com/v1";
export const SIWC_DYNAMIC_CLIENT = "dynamic_agent_client";
export const SIWC_AGENT_NAME = "AVA";
export const SIWC_SCOPE =
  "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
export const SIWC_PLAN_SCOPE = "chatgpt.tokens.use.direct";
/** Loopback: Host muss 127.0.0.1 sein, Pfad ist fest, Port frei waehlbar. */
export const SIWC_REDIRECT_URI = "http://127.0.0.1:1456/auth/callback";
export const SIWC_USAGE_URL = "https://chatgpt.com/settings/usage";

export interface SiwcPkce {
  verifier: string;
  challenge: string;
  state: string;
  nonce: string;
}

export interface SiwcTokenResult {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  expiresIn?: number;
  scope?: string;
  /** `sub` aus dem ID-Token (Kontoidentitaet). */
  subject?: string;
  email?: string;
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

export function generateSiwcPkce(): SiwcPkce {
  const verifier = base64url(randomBytes(32));
  return {
    verifier,
    challenge: base64url(createHash("sha256").update(verifier).digest()),
    state: base64url(randomBytes(32)),
    nonce: base64url(randomBytes(16)),
  };
}

/**
 * Installations-ID: einmal erzeugen, dauerhaft speichern. Sie identifiziert
 * dieses Geraet gegenueber OpenAI (nicht den Nutzer) und wird bei jeder
 * Anmeldung mitgeschickt.
 */
export function ladeOderErzeugeHostId(pfad: string): string {
  try {
    if (existsSync(pfad)) {
      const parsed = JSON.parse(readFileSync(pfad, "utf8")) as { hostId?: unknown };
      if (typeof parsed.hostId === "string" && parsed.hostId.startsWith("urn:uuid:")) return parsed.hostId;
    }
  } catch {
    /* neu erzeugen */
  }
  const hostId = `urn:uuid:${randomUUID()}`;
  mkdirSync(dirname(pfad), { recursive: true });
  writeFileSync(pfad, JSON.stringify({ hostId, erzeugtAm: new Date().toISOString() }, null, 2), { mode: 0o600 });
  return hostId;
}

export function buildSiwcAuthorizationUrl(args: {
  pkce: SiwcPkce;
  hostId: string;
  /** Gespeicherte oaiapp_-Client-ID; fehlt sie, ist es die Erstanmeldung. */
  clientId?: string | null;
  idTokenHint?: string | null;
  loginHint?: string | null;
  redirectUri?: string;
}): string {
  const erst = !args.clientId;
  const params = new URLSearchParams({
    client_id: args.clientId ?? SIWC_DYNAMIC_CLIENT,
    ext_agent_host_id: args.hostId,
    redirect_uri: args.redirectUri ?? SIWC_REDIRECT_URI,
    response_type: "code",
    scope: SIWC_SCOPE,
    resource: SIWC_RESOURCE,
    state: args.pkce.state,
    nonce: args.pkce.nonce,
    code_challenge_method: "S256",
    code_challenge: args.pkce.challenge,
  });
  if (erst) params.set("agent_name_hint", SIWC_AGENT_NAME);
  if (args.idTokenHint) params.set("id_token_hint", args.idTokenHint);
  if (args.loginHint) params.set("login_hint", args.loginHint);
  return `${SIWC_AUTHORIZE_URL}?${params.toString()}`;
}

export interface SiwcCallback {
  code: string | null;
  state: string | null;
  clientId: string | null;
  scope: string | null;
  error: string | null;
}

export function parseSiwcCallback(url: string): SiwcCallback {
  try {
    const u = new URL(url);
    return {
      code: u.searchParams.get("code"),
      state: u.searchParams.get("state"),
      clientId: u.searchParams.get("client_id"),
      scope: u.searchParams.get("scope"),
      error: u.searchParams.get("error"),
    };
  } catch {
    return { code: null, state: null, clientId: null, scope: null, error: "callback_unlesbar" };
  }
}

/** Nur die ausgegebene Client-ID gilt; `dynamic_agent_client` ist keine. */
export function istAusgegebeneClientId(v: string | null | undefined): v is string {
  return typeof v === "string" && v.startsWith("oaiapp_");
}

export function hatPlanScope(scope: string | null | undefined): boolean {
  return (scope ?? "").split(/[\s+]+/).includes(SIWC_PLAN_SCOPE);
}

export function decodeJwtPayload(jwt: string | undefined | null): Record<string, unknown> | null {
  if (!jwt) return null;
  const seg = jwt.split(".")[1];
  if (!seg) return null;
  try {
    return JSON.parse(Buffer.from(seg.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function tokenRequest(body: URLSearchParams, label: string): Promise<SiwcTokenResult> {
  const resp = await fetch(SIWC_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: body.toString(),
  });
  if (!resp.ok) {
    let detail = "";
    try {
      detail = await resp.text();
    } catch {
      detail = "<kein Antwort-Body>";
    }
    const err = new Error(`ChatGPT-${label} antwortete mit HTTP ${resp.status}: ${detail.slice(0, 500)}`);
    (err as Error & { status?: number; detail?: string }).status = resp.status;
    (err as Error & { detail?: string }).detail = detail;
    throw err;
  }
  const json = (await resp.json()) as Record<string, unknown>;
  if (typeof json.access_token !== "string" || json.access_token.length < 10) {
    throw new Error(`ChatGPT-${label}: Antwort enthielt kein gueltiges access_token.`);
  }
  const idPayload = decodeJwtPayload(typeof json.id_token === "string" ? json.id_token : undefined);
  const out: SiwcTokenResult = { accessToken: json.access_token };
  if (typeof json.refresh_token === "string") out.refreshToken = json.refresh_token;
  if (typeof json.id_token === "string") out.idToken = json.id_token;
  if (typeof json.expires_in === "number") out.expiresIn = json.expires_in;
  if (typeof json.scope === "string") out.scope = json.scope;
  if (idPayload) {
    if (typeof idPayload.sub === "string") out.subject = idPayload.sub;
    if (typeof idPayload.email === "string") out.email = idPayload.email;
  }
  return out;
}

export function exchangeSiwcCode(args: {
  code: string;
  verifier: string;
  clientId: string;
  redirectUri?: string;
}): Promise<SiwcTokenResult> {
  return tokenRequest(
    new URLSearchParams({
      grant_type: "authorization_code",
      code: args.code,
      redirect_uri: args.redirectUri ?? SIWC_REDIRECT_URI,
      client_id: args.clientId,
      code_verifier: args.verifier,
      resource: SIWC_RESOURCE,
    }),
    "Token",
  );
}

export function refreshSiwcToken(args: { refreshToken: string; clientId: string }): Promise<SiwcTokenResult> {
  return tokenRequest(
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: args.refreshToken,
      client_id: args.clientId,
      resource: SIWC_RESOURCE,
    }),
    "Refresh",
  );
}

/** Refresh-Fehler, nach denen nur eine Neuanmeldung hilft. */
export function refreshEndgueltigGescheitert(err: unknown): boolean {
  const e = err as { status?: number; detail?: string } | null;
  if (!e) return false;
  if (e.status === 400 || e.status === 401) {
    return /invalid_grant|invalid_refresh_token|token_expired|refresh_token_reused|invalid_client/.test(e.detail ?? "") || e.status === 401;
  }
  return false;
}
