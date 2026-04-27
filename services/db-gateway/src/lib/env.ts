import { z } from "zod";

// Gateway env schema. Validated once at startup — fail-fast per D11 (no
// degraded mode). Per-customer signing keys live in fly.io secrets as a
// single JSON blob keyed by tenant id (see JWT_PUBLIC_KEYS below).

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("production"),
  PORT: z.coerce.number().default(8080),

  // Gateway's own audit DB.
  DATABASE_URL: z.string().url(),
  DIRECT_URL: z.string().url().optional(),

  // Upstream service base URLs. Gateway fans out to these over HTTP and
  // forwards the caller's Bearer token (service-to-service JWT hardening is
  // a Step 7 item — see DESKTOP_DATA_FLOW.md Q4/5 follow-up).
  UPSTREAM_MASTER_DATA_URL: z.string().url(),
  UPSTREAM_COMPANY_PROFILE_URL: z.string().url(),
  UPSTREAM_COMPANY_CONTACT_URL: z.string().url(),
  UPSTREAM_COMPANY_PUBLICATION_URL: z.string().url(),
  UPSTREAM_COMPANY_EVALUATION_URL: z.string().url(),
  UPSTREAM_WEBSITE_URL: z.string().url(),
  UPSTREAM_STRUCTURED_CONTENT_URL: z.string().url(),

  // Event bus (AMQP today, NATS JetStream future per D1). Used by the SSE
  // bridge to subscribe to `transaction.progress` events and re-emit them
  // to the Desktop-App. Exchange name matches what the services publish to.
  EVENT_BUS_URL: z.string().url(),
  EVENT_BUS_EXCHANGE: z.string().default("exchange"),
  EVENT_BUS_QUEUE: z.string().default("db-gateway-progress"),

  // JWT signing material. Public keys as JSON: { "<tenantId>": "<pem>" }.
  // Private keys NEVER live in the gateway — they're held by the issuer
  // (customer's auth service on fly.io). Gateway only verifies.
  JWT_PUBLIC_KEYS: z
    .string()
    .transform((raw, ctx) => {
      try {
        const parsed = JSON.parse(raw) as Record<string, string>;
        if (typeof parsed !== "object" || parsed === null) throw new Error();
        return parsed;
      } catch {
        ctx.addIssue({ code: "custom", message: "JWT_PUBLIC_KEYS must be JSON {tenantId: pem}" });
        return z.NEVER;
      }
    }),
  JWT_ISSUER: z.string().default("ava-auth"),
  JWT_AUDIENCE: z.string().default("ava-gateway"),

  // Rate limit: sliding window, in-memory. Move to Redis once we have
  // >1 instance per customer (D3 notes this is acceptable for now).
  RATE_LIMIT_PER_MIN: z.coerce.number().default(600),

  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  // CORS allow-list, prod only. Comma-separated origins; the literal
  // value `electron` enables the `null` origin produced by Electron's
  // file:// renderer load. In dev (NODE_ENV !== "production") the
  // gateway mirrors the request Origin so any localhost port works.
  GATEWAY_ALLOWED_ORIGINS: z.string().optional(),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;
export function loadEnv(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    // eslint-disable-next-line no-console
    console.error("Invalid gateway env:", parsed.error.flatten());
    process.exit(1);
  }
  cached = parsed.data;
  return cached;
}
