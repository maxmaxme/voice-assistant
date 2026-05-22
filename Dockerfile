# syntax=docker/dockerfile:1.7
FROM node:24-bookworm-slim

# better-sqlite3 builds against the bundled Node ABI; node:24-bookworm-slim
# already ships build-essential's runtime libs. Only `ca-certificates` is
# needed for the OpenAI / Telegram / HA TLS connections.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Node deps first — better layer cache.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App sources (TypeScript run directly via Node 24's native type stripping —
# no tsc, no dist).
COPY src ./src
COPY tsconfig.json ./

# Persistent state lives on a host-mounted volume; create the mountpoint.
RUN mkdir -p /app/data && chown -R node:node /app

USER node

CMD ["node", "src/cli/unified.ts"]
