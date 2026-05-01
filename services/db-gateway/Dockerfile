# syntax=docker/dockerfile:1
FROM node:21-alpine AS builder
WORKDIR /app

RUN apk add --no-cache openssl libc6-compat

COPY package*.json ./
COPY .npmrc ./
COPY prisma ./prisma
RUN npm ci --quiet
# Strip the npmrc (with the gitlab token) from the image — runtime
# never needs it. `npm prune` later doesn't touch dotfiles.
RUN rm -f .npmrc

COPY tsconfig.json ./
COPY src ./src
RUN npx prisma generate
RUN npx tsc
RUN npm prune --omit=dev

# ---- Runtime ----
FROM node:21-alpine
WORKDIR /app
RUN apk add --no-cache openssl libc6-compat && addgroup -S app && adduser -S app -G app

COPY --from=builder --chown=app:app /app/node_modules ./node_modules
COPY --from=builder --chown=app:app /app/prisma ./prisma
COPY --from=builder --chown=app:app /app/dist ./dist
COPY --chown=app:app package.json ./

USER app
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "dist/index.js"]
