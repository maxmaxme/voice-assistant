# Nuxt SSR config panel. Runs its own Nitro Node server and opens the SQLite DB
# shared with the voice-assistant container (read/write `settings` + `prompts`).
FROM node:24-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
# Copy the full source BEFORE `npm ci`: the `postinstall: nuxt prepare` script
# needs nuxt.config + app/ present, and better-sqlite3's native build needs its
# install script (so --ignore-scripts is not an option).
COPY . .
RUN npm ci
RUN npm run build

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
# Nitro listens on $PORT (default 3000). The DB path is provided at runtime.
ENV PORT=3000
COPY --from=build /app/.output ./.output
EXPOSE 3000
CMD ["node", ".output/server/index.mjs"]
