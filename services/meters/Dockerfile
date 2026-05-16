FROM node:24-alpine

WORKDIR /app

# better-sqlite3 v12+ publishes prebuilt binaries for node-v137 linuxmusl-arm64
# (Node 24 + Alpine arm64), so no native compile toolchain is needed.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production \
    METERS_DATA_DIR=/app/data

VOLUME ["/app/data"]

ENTRYPOINT ["node", "src/index.ts"]
