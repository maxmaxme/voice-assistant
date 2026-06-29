# ⚙️ voice-assistant config panel

The web admin for [`voice-assistant`](../README.md) — a [Nuxt 4](https://nuxt.com/)
SSR app (Nuxt UI) that runs its own Nitro server and edits the **same SQLite
database** the assistant process uses. This is *the* way the assistant is
configured: no `.env` edits, no redeploys for config.

## What it edits

| Page             | Table(s)                | What                                                                 |
| ---------------- | ----------------------- | -------------------------------------------------------------------- |
| **Integrations** | `integrations`          | OpenAI (mandatory), Home Assistant, Telegram — install / enable / connection-test. Secrets (keys, tokens) are stored here, masked in the UI. |
| **Tools**        | `settings`              | Built-in tool gates (memory, reminders) + weather (units, location). |
| **Prompts**      | `prompts`               | Every system / tool prompt, editable, with restore-to-default.       |
| **Users**        | `users` + `identities`  | Principals and their devices: Telegram chats, HTTP tokens, voice device tokens. |
| **HA Voice / HTTP API** | `settings`       | Realtime enable switch (+ pacing / idle) and the per-endpoint HTTP toggles. |

**When changes take effect:**

- **Config** (`integrations`, `settings`, `prompts`) is read at the assistant's
  **startup** — these apply on the next restart, and the UI says so on save.
- **Users & devices** (`users`, `identities`) are read **per request**, so they
  apply **live** — add a user or device and it can authenticate immediately.

## Secrets

Secrets now live in the DB, entered through this panel, not in `.env`: the OpenAI
API key, the Home Assistant token, and the Telegram bot token are stored in the
`integrations` table and **masked** in every GET (the UI shows "leave blank to
keep"). The assistant's `.env` carries only process/infra knobs (DB path, TZ,
ports). Voice/HTTP bearer tokens are never stored raw at all — only their sha256
hash, as `identities` rows.

## Schema ownership

`voice-assistant` owns the schema and migrations. **This app never migrates** —
if a table doesn't exist yet, start the assistant once against the DB so it
creates them (a fresh-DB run also seeds the editable prompts). Reads tolerate
missing tables; writes return `503` until they exist.

> `server/utils/settable.ts` mirrors the assistant's `src/settings/settable.ts`.
> Keep the two in sync until they're extracted into a shared module.

## Dev

```bash
npm install
VA_DB_PATH=../data/assistant.db npm run dev   # this is the default
```

Open <http://localhost:3000>. The dev server talks to the sibling repo's
`data/assistant.db`.

## Build / run

```bash
npm run build
PORT=3000 VA_DB_PATH=/data/assistant.db node .output/server/index.mjs
```

## Deploy

Built as its own image and wired into the `home-infra` stack (port, Caddy +
tinyauth route, shared `data/` volume, `depends_on: voice-assistant`).
**Authentication is handled by the reverse proxy** — this app has no built-in
auth, so never expose it without one in front.
