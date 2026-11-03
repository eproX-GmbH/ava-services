// Verbindungsdaten fuer fremde Agenten-Plattformen (Copilot Studio u. a.), fertig
// zum Kopieren (Joyce 2026-11-03: "alles per Hand eintragen ist nervig"). Ein
// vertraulicher OAuth-Client je Organisation in Keycloak (keycloak-admin.ts);
// das Geheimnis kommt nur beim Anlegen und beim Erneuern zurueck.
import type pg from "pg";
import type { AuthContext } from "../middleware/auth";
import { TenantError } from "./tenant-error";
import { loadEnv } from "./env";
import { a2aClientAnlegen, a2aClientGeheimnisErneuern, a2aClientLesen, a2aClientLoeschen, a2aClientRedirectsSetzen, KeycloakAdminError } from "./keycloak-admin";

export interface A2aVerbindung {
  /** Fuer das Formular in Copilot Studio. */
  name: string;
  beschreibung: string;
  agentenkarteUrl: string;
  endpunktUrl: string;
  autorisierungsUrl: string | null;
  tokenUrl: string | null;
  aktualisierungsUrl: string | null;
  scopes: string;
  /** Vertraulicher Client (manuell), null = noch nicht angelegt. */
  client: { clientId: string; redirectUris: string[]; erstelltAm: string | null } | null;
  /** Nur direkt nach Anlegen/Erneuern. */
  secret?: string;
  /** Ob der A2A-Zugang (Org-Schalter mcp + mcp.a2a) freigeschaltet ist. */
  freigeschaltet: boolean;
}

async function istAdmin(pool: pg.Pool, tenantId: string, actorId: string): Promise<boolean> {
  const r = await pool.query<{ role: string }>(`SELECT "role" FROM "TenantMember" WHERE "tenantId" = $1 AND "actorId" = $2`, [tenantId, actorId]);
  return r.rows[0]?.role === "owner" || r.rows[0]?.role === "admin";
}

async function istOrganisation(pool: pg.Pool, tenantId: string): Promise<boolean> {
  const r = await pool.query<{ kind: string }>(`SELECT "kind" FROM "Tenant" WHERE "id" = $1`, [tenantId]);
  return r.rows[0]?.kind === "organisation";
}

async function pruefeAdmin(pool: pg.Pool, auth: AuthContext): Promise<void> {
  if (!(await istOrganisation(pool, auth.tenantId))) throw new TenantError(400, "Den Agenten-Zugang gibt es nur für Organisationen.");
  if (!(await istAdmin(pool, auth.tenantId, auth.actorId))) throw new TenantError(403, "Nur Admins der Organisation richten den Agenten-Zugang ein.");
}

export function redirectPruefen(uris: string[]): string[] {
  const out: string[] = [];
  for (const roh of uris) {
    const u = roh.trim();
    if (!u) continue;
    let parsed: URL;
    try {
      parsed = new URL(u);
    } catch {
      throw new TenantError(400, `Keine gültige Adresse: ${u.slice(0, 80)}`);
    }
    if (parsed.protocol !== "https:") throw new TenantError(400, "Weiterleitungs-Adressen müssen mit https beginnen.");
    if (!out.includes(u)) out.push(u);
  }
  if (out.length === 0) throw new TenantError(400, "Mindestens eine Weiterleitungs-Adresse aus Copilot Studio angeben.");
  if (out.length > 10) throw new TenantError(400, "Höchstens 10 Weiterleitungs-Adressen.");
  return out;
}

function kc(fn: () => Promise<never> | Promise<unknown>) {
  return fn().catch((err: unknown) => {
    if (err instanceof KeycloakAdminError) throw new TenantError(409, `Anmeldedienst: ${err.message.slice(0, 200)}`);
    throw err;
  });
}

export async function a2aVerbindung(pool: pg.Pool, auth: AuthContext, extra?: { secret?: string; client?: { clientId: string; redirectUris: string[]; erstelltAm: string | null } | null }): Promise<A2aVerbindung> {
  const env = loadEnv();
  const base = `https://${env.MCP_PUBLIC_HOST}`;
  const realm = (env.KEYCLOAK_REALM_URL ?? "").replace(/\/+$/, "");
  const { loadFeatures } = await import("./policy-guard");
  const f = await loadFeatures(pool, auth.tenantId);
  const client = extra?.client !== undefined ? extra.client : await (kc(() => a2aClientLesen(auth.tenantId)) as Promise<Awaited<ReturnType<typeof a2aClientLesen>>>);
  return {
    name: "AVA",
    beschreibung: "AVA liefert Firmenwissen aus Handelsregistern, Websites, Publikationen und LinkedIn: Firmen suchen und lesen, Ansprechpartner, Meldungen zu Geschäftsführerwechseln, Insolvenzen und Stellen, Firmen aufnehmen und recherchieren lassen.",
    agentenkarteUrl: `${base}/.well-known/agent-card.json`,
    endpunktUrl: `${base}/a2a`,
    autorisierungsUrl: realm ? `${realm}/protocol/openid-connect/auth` : null,
    tokenUrl: realm ? `${realm}/protocol/openid-connect/token` : null,
    aktualisierungsUrl: realm ? `${realm}/protocol/openid-connect/token` : null,
    scopes: "openid offline_access",
    client: client ? { clientId: client.clientId, redirectUris: client.redirectUris, erstelltAm: client.erstelltAm } : null,
    ...(extra?.secret ? { secret: extra.secret } : {}),
    freigeschaltet: f["mcp"] === true && f["mcp.a2a"] === true,
  };
}

export async function a2aClientErstellen(pool: pg.Pool, auth: AuthContext, input: { redirectUris: string[] }): Promise<A2aVerbindung> {
  await pruefeAdmin(pool, auth);
  const redirectUris = redirectPruefen(input.redirectUris);
  const tenantName = (await pool.query<{ name: string | null }>(`SELECT "name" FROM "Tenant" WHERE "id" = $1`, [auth.tenantId])).rows[0]?.name ?? auth.tenantId;
  const c = (await kc(() => a2aClientAnlegen({ tenantId: auth.tenantId, tenantName, redirectUris }))) as Awaited<ReturnType<typeof a2aClientAnlegen>>;
  // Vorhandener Client: Redirects ergaenzen.
  const alle = [...new Set([...c.redirectUris, ...redirectUris])];
  const stand = alle.length !== c.redirectUris.length ? ((await kc(() => a2aClientRedirectsSetzen(auth.tenantId, alle))) as Awaited<ReturnType<typeof a2aClientRedirectsSetzen>>) : c;
  return a2aVerbindung(pool, auth, { secret: c.secret, client: { clientId: stand.clientId, redirectUris: stand.redirectUris, erstelltAm: stand.erstelltAm } });
}

export async function a2aRedirectsAendern(pool: pg.Pool, auth: AuthContext, input: { redirectUris: string[] }): Promise<A2aVerbindung> {
  await pruefeAdmin(pool, auth);
  const redirectUris = redirectPruefen(input.redirectUris);
  const stand = (await kc(() => a2aClientRedirectsSetzen(auth.tenantId, redirectUris))) as Awaited<ReturnType<typeof a2aClientRedirectsSetzen>>;
  return a2aVerbindung(pool, auth, { client: { clientId: stand.clientId, redirectUris: stand.redirectUris, erstelltAm: stand.erstelltAm } });
}

export async function a2aGeheimnisErneuern(pool: pg.Pool, auth: AuthContext): Promise<A2aVerbindung> {
  await pruefeAdmin(pool, auth);
  const secret = (await kc(() => a2aClientGeheimnisErneuern(auth.tenantId))) as string;
  return a2aVerbindung(pool, auth, { secret });
}

export async function a2aClientEntfernen(pool: pg.Pool, auth: AuthContext): Promise<void> {
  await pruefeAdmin(pool, auth);
  await kc(() => a2aClientLoeschen(auth.tenantId));
}
