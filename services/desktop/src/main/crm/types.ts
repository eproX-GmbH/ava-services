// v0.1.54 — CRM integration types.
//
// Phase 1 surface: connect / disconnect / observe status across the
// three supported providers. Tokens live on the user's machine
// (safeStorage), never in the cloud. The gateway only mediates the
// OAuth token-exchange step (HubSpot in particular requires a
// `client_secret` we don't ship to clients; Salesforce + Dynamics
// could be desktop-direct but go through the gateway too for one
// consistent flow).

export type CrmProvider = "salesforce" | "hubspot" | "dynamics";

export const CRM_PROVIDERS: ReadonlyArray<CrmProvider> = [
  "salesforce",
  "hubspot",
  "dynamics",
];

/** Encrypted-at-rest token bundle. The desktop's safeStorage encrypts
 *  via the OS keychain (macOS Keychain Access, Windows DPAPI, libsecret
 *  on Linux). On Linux without libsecret, safeStorage refuses to
 *  encrypt — connection is treated as "not configured" in that case. */
export interface CrmTokens {
  /** OAuth bearer used for API calls. */
  accessToken: string;
  /** Used to mint a new access token when the current one expires.
   *  Salesforce + Dynamics + HubSpot all support refresh; null when
   *  the IdP returned only a short-lived token (rare). */
  refreshToken: string | null;
  /** Wallclock ms when accessToken stops being valid. The CRM
   *  manager refreshes ahead of expiry so an in-flight API call
   *  never lands on an expired bearer. */
  expiresAt: number;
  /** Per-provider extras the API layer needs to call the right
   *  endpoint. Salesforce uses `instance_url`; Dynamics uses the
   *  per-org base URL. HubSpot is uniformly `api.hubapi.com`. */
  extra: Record<string, string>;
}

/** What the renderer + agent tool see. Tokens are NEVER returned —
 *  only metadata sufficient to render a "Connected as ..." chip. */
export interface CrmStatus {
  provider: CrmProvider;
  /** false → not configured at all, no tokens stored. */
  connected: boolean;
  /** Display label of the connected account. Salesforce: org name +
   *  user email; HubSpot: portal id + user email; Dynamics: org URL.
   *  null when not connected. */
  account: string | null;
  /** ISO timestamp of the last successful token refresh. null when
   *  not connected or refresh has never been needed yet. */
  lastRefreshedAt: string | null;
  /** Last error from a refresh / API call attempt. Surfaced in the
   *  Settings card so the user sees why the connection broke. */
  lastError: string | null;
}

/** Internal record persisted alongside the encrypted tokens. Survives
 *  app restart; rebuilt into a CrmStatus on read. */
export interface CrmStoredRecord {
  provider: CrmProvider;
  /** Connected account label — derived once at connect time. */
  account: string;
  /** ISO timestamp set on each successful refresh. */
  lastRefreshedAt: string;
  /** Encrypted token blob (safeStorage.encryptString output). */
  encryptedTokens: string;
}

/** OAuth config for one provider — non-secret values that ship with
 *  the desktop. Secrets stay on the gateway; see services/db-gateway/
 *  src/routes/v1/crm.ts for the token-exchange proxy. */
export interface CrmProviderConfig {
  provider: CrmProvider;
  /** Display name in the Settings UI. */
  label: string;
  /** OAuth scopes requested at the authorize step. Provider-specific
   *  format (Salesforce uses space-separated; HubSpot uses
   *  space-separated with dotted scope names; Dynamics needs the
   *  scope-suffixed `.default`). */
  scope: string;
  /** Whether the desktop must collect any extra config from the user
   *  before starting OAuth (today: only Dynamics needs the org URL). */
  requiresOrgUrl: boolean;
}
