# syntax=docker/dockerfile:1.7
FROM node:24-bookworm-slim

# Native module build deps (in case of arm64 prebuild gaps),
# ALSA runtime + arecord (the `mic` npm package shells to it),
# Python + pip (for the openWakeWord daemon spawned from Node).
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential python3 python3-pip python3-venv \
      libasound2 alsa-utils \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# openWakeWord and its runtime deps. Versions match the local .venv so
# dev and prod hit the same models. PEP 668 ("externally managed") is
# bypassed inside the container — no system Python to protect here.
RUN pip install --no-cache-dir --break-system-packages \
      openwakeword==0.6.0 \
      onnxruntime==1.25.0 \
      numpy==2.4.4

WORKDIR /app

# Install Node deps first — better layer cache.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App sources (TypeScript run directly via Node 24's native type stripping —
# no tsc, no dist). Models are mounted from the host (see docker-compose.yml):
# they're large binaries that change independently of code.
COPY src ./src
COPY scripts ./scripts
COPY tsconfig.json ./

# Persistent state lives on a host-mounted volume; create the mountpoint.
RUN mkdir -p /app/data /app/models && chown -R node:node /app

USER node

CMD ["node", "src/cli/run.ts"]
