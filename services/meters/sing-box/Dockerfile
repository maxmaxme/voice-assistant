# Stage 1: strip TS types with Node 24
FROM node:24-alpine AS stripper
WORKDIR /app
COPY src/proxy/parseVlessUrl.ts ./parseVlessUrl.ts
RUN npm install -g typescript && \
    npx tsc parseVlessUrl.ts --outDir ./out --target es2022 --module es2022 --ignoreConfig && \
    mv out/parseVlessUrl.js parseVlessUrl.mjs

FROM ghcr.io/sagernet/sing-box:latest

RUN apk add --no-cache nodejs

COPY --from=stripper /app/parseVlessUrl.mjs /parseVlessUrl.mjs
COPY sing-box/entrypoint.mjs /entrypoint.mjs

ENTRYPOINT ["/usr/bin/node", "/entrypoint.mjs"]
