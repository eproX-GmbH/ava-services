# @ava/db-gateway

Thin REST gateway on fly.io that brokers Postgres access for the Electron
desktop app. One fly app per customer.

See `/Users/mac/Desktop/Repos/ava-services/DECISIONS.md` D3 for the full
decision record (Hono, REST + OpenAPI, JWT auth, audit log, rate limit).

## Scope

**Step 5 deliberately ships infrastructure only.** The operational endpoint
surface is derived from the Desktop-App's actual data flow (D3, last
paragraph). Until that spec lands, `/v1/` contains only a `/whoami`
placeholder — add real endpoints to `src/routes/v1.ts` as each is scoped.

## What's wired

- **Hono** app with `@hono/zod-openapi` for typed routes + OpenAPI spec.
  Swagger UI at `/docs`, JSON at `/openapi.json`.
- **JWT auth** via `jose`. Access tokens (15min) verified against a
  per-tenant public key held in the `JWT_PUBLIC_KEYS` env (JSON map).
  Refresh flow is the issuer's job, not the gateway's.
- **Rate limit** — in-memory sliding window per tenant, 600/min default.
  Redis swap documented in D3 for when we scale past one instance per
  customer.
- **Audit log** — one `AuditLog` row per authenticated request, written
  async (failures logged, never blocking). Schema in `prisma/schema.prisma`.
- **fly.toml** — template config with `/health` liveness probe.
  Duplicate per customer and set `app = "<customer>-db-gateway"`.

## What's explicitly out

- No operational endpoints (see Scope above).
- No schema mirroring the services. The gateway owns only `audit_log`;
  real data is reached through `UPSTREAM_DATABASE_URL`.
- No offline semantics (D11).
- No Redis — rate limit is intentionally single-instance for now.

## Local dev

```bash
cp .env.example .env
npm install
npm run prisma:generate
npm run prisma:migrate:dev
npm run dev
```

Then: `curl http://localhost:8080/health`

## Deploy

```bash
fly secrets set DATABASE_URL=... UPSTREAM_DATABASE_URL=... JWT_PUBLIC_KEYS='{"acme":"-----BEGIN..."}'
fly deploy
```
