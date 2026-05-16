# Playwright base image — comes with chromium + system fonts.
FROM mcr.microsoft.com/playwright:v1.50.0-jammy

# Install Node 24 (base image has Node 22; need 24 for native TS stripping).
# The Playwright base already has build-essential, but we need to ensure it's available.
RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && \
    apt-get install -y nodejs build-essential

WORKDIR /app

# Install deps with prebuilt better-sqlite3 binaries.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && \
    npm rebuild better-sqlite3

# Copy source (no build step — Node 24 strips TS at runtime).
COPY tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production \
    METERS_DATA_DIR=/app/data \
    PROXY_URL=socks5://sing-box-ru:1080

VOLUME ["/app/data"]

ENTRYPOINT ["node", "src/index.ts"]
