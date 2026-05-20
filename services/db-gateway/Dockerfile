# syntax=docker/dockerfile:1
FROM node:21-alpine AS builder
WORKDIR /app

RUN apk add --no-cache openssl libc6-compat

COPY package*.json ./
COPY .npmrc ./
COPY prisma ./prisma
COPY prisma-company-contact ./prisma-company-contact
# v0.1.252 — NPM_TOKEN per BuildKit-Secret-Mount injizieren statt im
# .npmrc committen. Der Secret ist NUR während dieses RUN-Step
# verfügbar (als env-var); er landet weder in einer Layer noch im
# fertigen Image. fly deploy muss `--build-secret npm_token=<glpat-...>`
# durchreichen, sonst schlägt `npm ci` mit 401 fehl.
RUN --mount=type=secret,id=npm_token,env=NPM_TOKEN npm ci --quiet
# Strip the .npmrc from the image — runtime never needs it.
# `npm prune` later doesn't touch dotfiles.
RUN rm -f .npmrc

COPY tsconfig.json ./
COPY src ./src
# Two prisma clients:
#   prisma/                  — gateway audit DB (AuditLog + EntityProgress)
#   prisma-company-contact/  — vendored mirror of company-contact's schema
#                              for §8.v3 Phase 3 reconciliation in
#                              src/lib/contact-extraction/.
RUN npx prisma generate
RUN npx prisma generate --schema prisma-company-contact/schema.prisma
RUN npx tsc
RUN npm prune --omit=dev

# ---- Runtime ----
FROM node:21-alpine
WORKDIR /app
RUN apk add --no-cache openssl libc6-compat && addgroup -S app && adduser -S app -G app

COPY --from=builder --chown=app:app /app/node_modules ./node_modules
COPY --from=builder --chown=app:app /app/prisma ./prisma
COPY --from=builder --chown=app:app /app/prisma-company-contact ./prisma-company-contact
COPY --from=builder --chown=app:app /app/generated ./generated
COPY --from=builder --chown=app:app /app/dist ./dist
COPY --chown=app:app package.json ./

USER app
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "dist/index.js"]
