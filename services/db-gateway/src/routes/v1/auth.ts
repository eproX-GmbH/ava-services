import { OpenAPIHono, z } from "@hono/zod-openapi";
import { logger } from "../../lib/logger";
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
// Mounted at app level (NOT under the /v1 auth middleware) so the
// Bearer-token chain doesn't reject anonymous calls. See index.ts.
//
// v0.1.253 — uses plain `.post()` (like the Stripe webhook router) instead
// of `.openapi()`. The `.openapi()` registration path collides with the
// /v1 router's auth middleware in Hono's matching order: even though
// publicAuthRouter is mounted FIRST at "/" in index.ts, an OpenAPIHono
// route registered via `.openapi()` ends up in the regexp-router pool
// which has lower priority than the v1 trie router. Result before this
// fix: requests to /v1/auth/register returned `401 missing_bearer_token`
// from the auth middleware, never reaching this handler. The webhook
// router (`billingWebhookRouter`) uses `.post()` directly and works —
// so we mirror that pattern here.

const RegisterBody = z.object({
  firstName: z.string().min(1, "Vorname fehlt").max(80, "Vorname zu lang"),
  lastName: z.string().min(1, "Nachname fehlt").max(80, "Nachname zu lang"),
  email: z.string().email("Bitte eine gültige E-Mail-Adresse angeben"),
  password: z
    .string()
    .min(8, "Passwort muss mindestens 8 Zeichen haben")
    .max(128, "Passwort zu lang"),
  // Pflicht-Checkbox: der Client darf hier nur literal `true` schicken.
  // Schickt er `false` oder lässt er das Feld weg, lehnen wir die
  // Anfrage als invalid_input ab.
  acceptTerms: z.literal(true, {
    errorMap: () => ({
      message: "AGB und Datenschutzerklärung müssen akzeptiert werden",
    }),
  }),
});

export const publicAuthRouter = new OpenAPIHono();

publicAuthRouter.post("/v1/auth/register", async (c) => {
  // Manuelle Body-Parse + zod-Validierung (kein c.req.valid("json")
  // mehr, weil das nur mit .openapi()-Routes funktioniert).
  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json(
      {
        error: "invalid_input",
        message: "Request-Body muss valides JSON sein.",
      },
      400,
    );
  }
  const parsed = RegisterBody.safeParse(rawBody);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    return c.json(
      {
        error: "invalid_input",
        message: firstIssue?.message ?? "Eingabe ist ungültig.",
        detail: { issues: parsed.error.issues },
      },
      400,
    );
  }
  const body = parsed.data;
  const ip = pickClientIp(c.req.raw);

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
