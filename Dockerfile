# ─── Stage 1: Build ───────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS builder

WORKDIR /app

COPY package*.json tsconfig.json ./
RUN npm ci

COPY src/ ./src/
RUN npm run build

# ─── Stage 2: Scraper runtime (Playwright + Xvfb) ─────────────────────────────
FROM mcr.microsoft.com/playwright:v1.59.1-jammy AS runtime

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist         ./dist
COPY --from=builder /app/package.json ./package.json

RUN apt-get update -qq && \
    apt-get install -y --no-install-recommends xvfb && \
    rm -rf /var/lib/apt/lists/*

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV DISPLAY=:99
ENV DB_HOST=db
ENV DB_PORT=5432
ENV DB_NAME=scraper
ENV DB_USER=postgres
ENV DB_PASSWORD=postgres

# Run Xvfb virtual display then the CLI scraper
CMD ["xvfb-run", "-a", "-s", "-screen 0 1366x768x24", "node", "dist/index.js"]

# ─── Stage 3: Web server (Playwright image — can also run scraper jobs) ────────
FROM mcr.microsoft.com/playwright:v1.59.1-jammy AS web

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist         ./dist
COPY --from=builder /app/package.json ./package.json
# Static frontend files
COPY public/ ./public/

RUN apt-get update -qq && \
    apt-get install -y --no-install-recommends xvfb && \
    rm -rf /var/lib/apt/lists/*

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV DISPLAY=:99
ENV DB_HOST=db
ENV DB_PORT=5432
ENV DB_NAME=scraper
ENV DB_USER=postgres
ENV DB_PASSWORD=postgres
ENV PORT=3000

EXPOSE 3000

# Start Xvfb virtual display then the web server
CMD ["sh", "-c", "Xvfb :99 -screen 0 1366x768x24 -ac &>/dev/null & sleep 1 && node dist/server.js"]
