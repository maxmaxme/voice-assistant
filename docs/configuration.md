# Configuration, channels & auth

## ⚙️ Configuration

Two sources, both applied on the next process start.

**Web panel ([`web/`](../web/))** — a separate [Nuxt](https://nuxt.com/) SSR app over the shared SQLite DB. It owns:

| Page                    | What you set                                                                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Integrations**        | OpenAI (key, model, effort, web search, realtime model/voice), HA (url + token), Telegram (bot token) — install / enable / connection-test |
| **Tools**               | Built-in tool gates (memory, reminders) + weather (units, default location)                                                                |
| **Prompts**             | Every system / tool prompt, editable, restore-to-default                                                                                   |
| **Users**               | Principals and their devices/identities (Telegram chats, HTTP & voice tokens)                                                              |
| **HA Voice / HTTP API** | Realtime enable switch (+ pacing / idle) and per-endpoint HTTP toggles                                                                     |

**`.env`** — process/infra only, **no secrets**:

| Variable           | Purpose                                | Default             |
| ------------------ | -------------------------------------- | ------------------- |
| `MEMORY_DB_PATH`   | SQLite file shared with the web panel  | `data/assistant.db` |
| `TZ`               | IANA timezone for scheduling / display | system tz           |
| `HTTP_SERVER_PORT` | HTTP server port                       | `3000`              |
| `REALTIME_PORT`    | realtime WebSocket port                | `3001`              |
| `LOG_LEVEL`        | `debug` / `info` / `warn` / …          | `info`              |

## 🔌 Channels

### 🔊 Voice PE (realtime)

Enable it on the panel's **HA Voice** page; the server listens at `ws://<host>:3001/voice`. A speaker authenticates by presenting its own device token — hashed and matched against a `voice` identity; unknown tokens are rejected at the handshake. Each speaker is its own principal, so it gets its own personal memory (e.g. its room). Register one with `npm run users -- attach-voice` or the Users page.

### 🌐 HTTP

The HTTP server always runs (so `GET /health` is always up for the container healthcheck); each input endpoint mounts only when its panel toggle is on.

| Endpoint       | Body                                                                         | Returns                             |
| -------------- | ---------------------------------------------------------------------------- | ----------------------------------- |
| `POST /text`   | form-urlencoded or JSON, `text` + optional `conversation_id`                 | `{response}`                        |
| `POST /audio`  | raw audio bytes (Content-Type sets the format), optional `?conversation_id=` | `{response, transcript}`            |
| `POST /assist` | JSON `{text, conversation_id?}` — HA Assist bridge                           | `{response, continue_conversation}` |
| `GET /health`  | —                                                                            | `{status:"ok"}`                     |

All non-health endpoints require `Authorization: Bearer <token>`.

`/mcp` (always mounted) is an MCP server (Streamable HTTP, stateless) for external voice front-ends such as [pipecat-voice](https://github.com/maxmaxme/pipecat-voice). It authenticates with a **speaker's device token** (a `voice` identity, not an HTTP token) and serves that speaker's view: the Home Assistant tools plus the built-in ones (memory, reminders, weather, time), and prompts — `voice-system` (the realtime instructions with the speaker's memory and language) and the descriptions of the `wait_for_user` / `request_follow_up` device-flow tools. The `voice://realtime-config` resource carries the Realtime page's settings (plus the OpenAI integration's realtime model/voice/effort), so the front-end follows the panel; edits apply on its next connection.

`/text` keeps a server-side conversation per `conversation_id` (10 min idle), scoped to the calling token — so a follow-up like "yes, send it" lands in the same chain. Omit the field and the token gets one shared chain; send a new id to start a fresh topic. `/audio` joins the same chain when given `?conversation_id=` in the query (the body is the audio); without it, every request is a fresh one-shot conversation.

### 💬 Telegram

Install & enable the **Telegram** integration (bot token from [@BotFather](https://t.me/BotFather)). The bot takes text, voice, and photos and streams replies as live drafts. Commands: `/start`, `/help`, `/reset`, `/profile`, `/update`. A chat is admitted only once it's a registered identity:

```bash
npm run users -- attach-telegram --user <id> --chat <chatId>
```

There is no fixed outbound chat — `send_to_telegram` and the reminder scheduler resolve a recipient's chat from these identities.

## 🔐 Users, auth & memory

Auth is entirely **DB-backed** — no env allow-lists. Each request resolves to a principal, which sets its memory scope:

- **Telegram** — admitted iff a `(telegram, chatId)` identity exists
- **HTTP** — the Bearer token's sha256 hash must match an `http` identity
- **Voice** — the WS bearer's sha256 hash must match a `voice` identity

Memory splits into a shared `household` scope and per-principal `personal` scopes: every principal **reads** `household ∪ personal(self)` and **writes** personal by default. Manage principals from the Users page or the `users` CLI:

```bash
npm run users -- add-user        --name Alex
npm run users -- attach-telegram --user <id> --chat <chatId>
npm run users -- attach-voice    --user <id> --token <device-token>
npm run users -- mint-http       --user <id>     # printed once; only its hash is stored
npm run users -- set-admin       --user <id>
```
