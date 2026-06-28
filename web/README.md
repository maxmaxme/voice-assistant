# voice-assistant config web

A small Nuxt 4 (SSR, Nuxt UI) app that edits the voice-assistant's runtime
configuration. It runs its own Nitro Node server and opens the **same SQLite
database** the voice-assistant process uses, reading/writing two tables:

- `settings` — non-secret config overrides keyed by env-var name. Layered over
  `process.env` by voice-assistant's `loadConfig` **at startup**.
- `prompts` — editable prompt text (currently `base-system`), seeded by
  voice-assistant from its bundled markdown on first run.

**Secrets** (`OPENAI_API_KEY`, `HA_TOKEN`, `TELEGRAM_BOT_TOKEN`,
`VA_DEVICE_TOKEN`) are never exposed here — they stay in `.env`.

**Changes apply on the next restart** of the voice-assistant container, by
design. The UI says so on every save.

## Schema ownership

voice-assistant owns the schema and migrations. This app **never migrates** —
if the `settings`/`prompts` tables don't exist yet, start voice-assistant once
against the DB so it can create them (a fresh-DB seed also populates the
editable prompts). Reads tolerate the missing tables; writes return 503 until
they exist.

> `server/utils/settable.ts` is a copy of voice-assistant's
> `src/settings/settable.ts`. Keep the two in sync until they're extracted into
> a shared module.

## Dev

```bash
npm install
VA_DB_PATH=../data/assistant.db npm run dev   # default already points here
```

Open http://localhost:3000. The dev server talks to the sibling repo's
`data/assistant.db`.

## Build / run

```bash
npm run build
PORT=3000 VA_DB_PATH=/data/assistant.db node .output/server/index.mjs
```

## Deploy

Built as its own image and wired into `home-infra` (port, Caddy + tinyauth
route, shared `data/` volume, `depends_on: voice-assistant`). Auth is handled by
the reverse proxy — this app has no built-in auth.
