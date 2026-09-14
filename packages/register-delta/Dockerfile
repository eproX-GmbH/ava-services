# Register-Delta Betreiber-Fallback-Worker (docs/PLAN_STAMMDATEN_DELTA.md S5).
# Standalone: einzige Laufzeitabhaengigkeit ist selenium-webdriver, Chromium
# und der passende chromedriver kommen aus Alpine.
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json tsconfig.json ./
COPY src ./src
RUN npm install --quiet && npm run build

FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache chromium chromium-chromedriver nss freetype harfbuzz ca-certificates ttf-freefont
ENV NODE_ENV=production CHROME_BIN=/usr/bin/chromium SE_AVOID_STATS=true
COPY package.json ./
RUN npm install --omit=dev --quiet
COPY --from=builder /app/dist ./dist
# Nicht als root: Chromium verweigert sonst den Start ohne --no-sandbox-Tricks.
RUN addgroup -S worker && adduser -S -G worker worker && chown -R worker:worker /app
USER worker
CMD ["node", "dist/cli.js"]
