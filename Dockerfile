# syntax=docker/dockerfile:1.26
FROM node:24-bookworm-slim

# Only `ca-certificates` is needed for the OpenAI / Telegram / HA TLS
# connections — no compiler toolchain, see the --ignore-scripts note below.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Node deps first — better layer cache.
# --ignore-scripts: no prod dependency has an install script, but
# better-sqlite3 >=13 still ships a binding.gyp next to its prebuilt N-API
# binaries, and npm runs a default `node-gyp rebuild` for it regardless of the
# package's own "gypfile": false. Without this the build demands a Python +
# C++ toolchain to produce a binary the tarball already contains.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# App sources (TypeScript run directly via Node 24's native type stripping —
# no tsc, no dist).
COPY src ./src
COPY tsconfig.json ./
# Drizzle migration files, read at runtime by applyMigrations().
COPY drizzle ./drizzle

# Persistent state lives on a host-mounted volume; create the mountpoint.
RUN mkdir -p /app/data && chown -R node:node /app

USER node

CMD ["node", "src/cli/unified.ts"]
