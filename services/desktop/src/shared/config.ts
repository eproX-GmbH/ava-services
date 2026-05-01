// Shared, *public-only* configuration source-of-truth (Phase 8.u2).
//
// Three buckets — strict separation:
//   1. Public config (this file)
//      Gateway URL, OIDC issuer + client id, update channel, app version.
//      Bundled in plain text. Anyone unzipping the .asar can read these,
//      and that's fine: a public OIDC client id is not a secret, and the
//      gateway URL is the same one a network sniffer would see anyway.
//   2. Per-user secrets (NOT here)
//      OIDC tokens, model API keys the user pastes in. Stored via
//      `safeStorage` (Keychain / DPAPI / libsecret) under userData.
//   3. Server-only secrets (NEVER on desktop)
//      Postgres credentials, service-role tokens, Keycloak admin creds.
//      Live exclusively on Fly.io / the gateway. The desktop binary must
//      never reference them, even by accident — `scripts/check-bundle-secrets.mjs`
//      enforces this.
//
// Layered resolution at *runtime* (main process):
//   1. process.env.AVA_*  — packaged builds inject via electron-builder's
//      `extraMetadata` or a `.env` file the launcher exports. Highest
//      priority so a user can override gateway URL for self-hosting.
//   2. Build-time bake   — values stamped into the bundle by CI through
//      AVA_* env at build time. (Same vars; the build sees them via
//      `electron-vite build` env passthrough.)
//   3. Hard-coded prod defaults below — what ships when neither of the
//      above is set. Values point at the production fly.io gateway and
//      the production Keycloak realm.
//
// IMPORTANT: this module is imported by the *main* process only. The
// renderer learns the values via `app:getConfig` IPC, so we never have
// to thread `process.env` through the bundler.

import type { AppConfig } from "./types";

// ---- Hard-coded production defaults ----------------------------------------
//
// Shipping defaults: any user who installs the .dmg / .exe and does
// nothing else gets these. Update by editing this file and cutting a
// new release tag.
const PROD_DEFAULTS = {
  // Live fly.io endpoints (Phase 8.u — pilot deploy):
  //   gateway: services/db-gateway/fly.toml → ava-db-gateway
  //   issuer:  shared keycloak realm `ava`
  gatewayUrl: "https://ava-db-gateway.fly.dev",
  authIssuer: "https://fly-keycloak-broken-bird-3701.fly.dev/realms/ava",
  authClientId: "ava-desktop",
  updateChannel: "latest" as const,
} as const;

// ---- Hard-coded development defaults ---------------------------------------
//
// Used when NODE_ENV !== "production" AND no AVA_* env override is set.
// Matches the values our compose stack hands out for the dev Keycloak
// realm and the local gateway port (D7 setup).
const DEV_DEFAULTS = {
  gatewayUrl: "http://localhost:8080",
  authIssuer: "http://auth.localhost/realms/ava",
  authClientId: "ava-desktop",
  updateChannel: "alpha" as const,
} as const;

export type UpdateChannel = "latest" | "beta" | "alpha";

export interface ResolvedConfig extends AppConfig {
  authIssuer: string;
  authClientId: string;
  updateChannel: UpdateChannel;
  /** App version — sourced from package.json by electron at runtime. */
  appVersion: string;
  /** Whether dev auth bypass is on (NEVER true in packaged builds). */
  devAuthBypass: boolean;
  /** Whether this build was launched via electron-vite dev. */
  isDev: boolean;
}

function pickChannel(raw: string | undefined): UpdateChannel {
  if (raw === "beta" || raw === "alpha" || raw === "latest") return raw;
  return PROD_DEFAULTS.updateChannel;
}

/**
 * Resolve the runtime config in the main process.
 *
 * Pass `appVersion` and `isDev` from the caller (the main `index.ts`
 * boot has access to `app.getVersion()` and `app.isPackaged`) so this
 * module stays free of an `electron` import — keeps it cheap to test.
 */
export function resolveConfig(opts: {
  appVersion: string;
  isPackaged: boolean;
  env?: NodeJS.ProcessEnv;
}): ResolvedConfig {
  const env = opts.env ?? process.env;
  const isDev = !opts.isPackaged;
  const defaults = isDev ? DEV_DEFAULTS : PROD_DEFAULTS;

  // Dev-auth-bypass is intentionally guarded twice: it must be on AND
  // we must not be in a packaged build. The second check is the
  // belt-and-braces — even if a packaged build somehow had the env var
  // set (a curious user, an over-eager sysadmin), we refuse it.
  const devAuthBypass = env.AVA_DEV_AUTH_BYPASS === "1" && isDev;

  return {
    gatewayUrl: env.AVA_GATEWAY_URL ?? env.GATEWAY_URL ?? defaults.gatewayUrl,
    authIssuer: env.AVA_AUTH_ISSUER ?? env.AUTH_ISSUER ?? defaults.authIssuer,
    authClientId:
      env.AVA_AUTH_CLIENT_ID ?? env.AUTH_CLIENT_ID ?? defaults.authClientId,
    updateChannel: pickChannel(env.AVA_UPDATE_CHANNEL),
    appVersion: opts.appVersion,
    devAuthBypass,
    isDev,
  };
}
