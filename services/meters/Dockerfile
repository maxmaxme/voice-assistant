FROM node:24-alpine

WORKDIR /app

# better-sqlite3 ships prebuilds for alpine-musl on most arches, but fall back
# to source compile if the prebuild is missing.
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && \
    npm rebuild better-sqlite3

COPY tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production \
    METERS_DATA_DIR=/app/data

VOLUME ["/app/data"]

ENTRYPOINT ["node", "src/index.ts"]
