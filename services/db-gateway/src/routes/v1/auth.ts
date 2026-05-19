import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { logger } from "../../lib/logger";
import { ErrorShape } from "./schemas";
import {
  createUser,
  KeycloakAdminError,
  RegistrationDisabledError,
} from "../../lib/keycloak-admin";
import { passwordGrant } from "../../lib/keycloak-tokens";
import { takeRegistrationSlot } from "../../lib/auth-rate-limit";

// In-App-Registration endpoint (POST /v1/auth/register).
//
// Unauthenticated by design — the user doesn't have an account yet.
// Mounted at app level (not under the /v1 auth middleware) so the
// Bearer-token chain doesn't reject anonymous calls. See index.ts.
//
// Flow:
//   1. Validate input (zod). Bad payload → 400 invalid_input.
//   2. Rate-limit per IP (5 req / hour / pod). Over → 429.
//   3. Create the user via Keycloak Admin API. 409 → email_taken.
//   4. Exchange email+password for an OIDC token-set via ROPC against
//      the `ava-registration` public client.
//   5. Return tokens. Desktop adopts them via the existing
//      applyTokens() path → user is signed in.
//
// When the operator hasn't configured the registration secrets, the
// route returns 503 "registration disabled" — deployments that don't
// want self-serve sign-up can simply not set the env vars.

const tag = "auth";

export const RegisterBody = z
  .object({
    firstName: z
      .string()
      .min(1, "Vorname fehlt")
      .max(80, "Vorname zu lang"),
    lastName: z
      .string()
      .min(1, "Nachname fehlt")
      .max(80, "Nachname zu lang"),
    email: z.string().email("Bitte eine gültige E-Mail-Adresse angeben"),
    password: z
      .string()
      .min(8, "Passwort muss mindestens 8 Zeichen haben")
      .max(128, "Passwort zu lang"),
    // Pflicht-Checkbox: der Client darf hier nur literal `true`
    // schicken. Schickt er `false` oder lässt er das Feld weg, lehnen
    // wir die Anfrage als invalid_input ab.
    acceptTerms: z.literal(true, {
      errorMap: () => ({
        message: "AGB und Datenschutzerklärung müssen akzeptiert werden",
      }),
    }),
  })
  .openapi("RegisterBody");

const RegisterResponse = z
  .object({
    accessToken: z.string(),
    refreshToken: z.string(),
    idToken: z.string().optional(),
    expiresIn: z.number(),
    refreshExpiresIn: z.number().optional(),
    tokenType: z.string(),
  })
  .openapi("RegisterResponse");

const registerRoute = createRoute({
  method: "post",
  path: "/v1/auth/register",
  tags: [tag],
  summary: "Self-serve user registration (creates Keycloak user + returns tokens)",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: RegisterBody } },
    },
  },
  responses: {
    201: {
      content: { "application/json": { schema: RegisterResponse } },
      description: "user created, signed-in tokens returned",
    },
    400: {
      content: { "application/json": { schema: ErrorShape } },
      description: "invalid input or weak password",
    },
    409: {
      content: { "application/json": { schema: ErrorShape } },
      description: "email already registered",
    },
    429: {
      content: { "application/json": { schema: ErrorShape } },
      description: "rate limited",
    },
    502: {
      content: { "application/json": { schema: ErrorShape } },
      description: "Keycloak unreachable / misconfigured",
    },
    503: {
      content: { "application/json": { schema: ErrorShape } },
      description: "self-serve registration disabled",
    },
  },
});

export const publicAuthRouter = new OpenAPIHono();

publicAuthRouter.openapi(registerRoute, async (c) => {
  const ip = pickClientIp(c.req.raw);
  const body = c.req.valid("json");

  // Rate-limit BEFORE Keycloak so a flood doesn't burn admin-token
  // capacity. Bad-payloads have already failed zod above this line, so
  // we only count well-formed attempts.
  const slot = takeRegistrationSlot(ip);
  if (!slot.allowed) {
    c.header("Retry-After", String(slot.retryAfterSeconds));
    return c.json(
      {
        error: "rate_limited",
        message:
          "Zu viele Registrierungsversuche von dieser IP. Bitte in einer Stunde erneut probieren.",
      },
      429,
    );
  }

  try {
    const userId = await createUser({
      email: body.email.trim().toLowerCase(),
      firstName: body.firstName.trim(),
      lastName: body.lastName.trim(),
      password: body.password,
    });
    logger.info(
      { userId, email: redactEmail(body.email) },
      "[register] keycloak user created",
    );

    const tokens = await passwordGrant(
      body.email.trim().toLowerCase(),
      body.password,
    );
    return c.json(
      {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        idToken: tokens.id_token,
        expiresIn: tokens.expires_in,
        refreshExpiresIn: tokens.refresh_expires_in,
        tokenType: tokens.token_type,
      },
      201,
    );
  } catch (err) {
    if (err instanceof RegistrationDisabledError) {
      logger.error(
        { reason: err.message },
        "[register] disabled — operator must configure KEYCLOAK_REGISTRAR_* + KEYCLOAK_REGISTRATION_CLIENT_ID",
      );
      return c.json(
        {
          error: "registration_disabled",
          message:
            "Selbst-Registrierung ist auf diesem Server nicht aktiviert. Bitte den Betreiber kontaktieren.",
        },
        503,
      );
    }
    if (err instanceof KeycloakAdminError) {
      // Map the structured error kind to the HTTP status + a German
      // message the renderer can show directly.
      switch (err.errorKind) {
        case "email_taken":
          return c.json(
            {
              error: "email_taken",
              message: "Für diese E-Mail-Adresse existiert bereits ein Konto.",
            },
            409,
          );
        case "weak_password":
          return c.json(
            {
              error: "weak_password",
              message:
                "Das Passwort erfüllt die Sicherheits-Richtlinie nicht (mind. 8 Zeichen, Misch aus Buchstaben + Zahlen empfohlen).",
            },
            400,
          );
        case "invalid_input":
          return c.json(
            {
              error: "invalid_input",
              message:
                "Eingabe wurde abgelehnt. Bitte Felder prüfen und erneut versuchen.",
            },
            400,
          );
        default:
          logger.error(
            { status: err.status, body: err.body.slice(0, 300) },
            "[register] keycloak error",
          );
          return c.json(
            {
              error: "keycloak_error",
              message:
                "Der Authentifizierungs-Server hat einen Fehler gemeldet. Bitte später erneut versuchen.",
            },
            502,
          );
      }
    }
    logger.error({ err }, "[register] unexpected failure");
    return c.json(
      {
        error: "server_error",
        message: "Unbekannter Fehler beim Anlegen des Kontos.",
      },
      502,
    );
  }
});

// ---- Helpers ----------------------------------------------------------------

function pickClientIp(req: Request): string {
  // fly.io sets X-Forwarded-For with the real client IP first. In dev
  // we may not have a proxy in front — fall back to a fixed marker so
  // the rate-limit still works per-process.
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) {
    const first = fwd.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.headers.get("fly-client-ip") ?? "unknown";
}

/** Logs without leaking the full email — keeps the domain for ops
 *  triage, masks the local part. */
function redactEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "<redacted>";
  return `${email.slice(0, 1)}***${email.slice(at)}`;
}
