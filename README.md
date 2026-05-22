# voice-assistant

Personal voice assistant for smart-home control. Targets a Raspberry Pi 5
runtime, developed on macOS. Cloud-heavy stack: OpenAI for STT
(`gpt-4o-transcribe`), LLM (`gpt-4o`), and TTS (handled by Home Assistant
on the smart-speaker side); Home Assistant via the official MCP Server
integration.

Voice input arrives via the Voice PE smart speaker → Home Assistant
Assist pipeline → custom HA bridge component (in the separate `home-infra`
repo) → this service's HTTP `/text` endpoint. Telegram is the secondary
channel.

## Status

Iterations 1-4 + Memory Level 1 done. The Pi deployment artifacts
(Iter 5) — docker-compose, systemd units, install scripts — live in a
separate host-infra repo. This repo just ships the app + image
(`Dockerfile` at the root, published to `ghcr.io/maxmaxme/voice-assistant`
by CI).

Working features:

- HA control via natural language over Telegram + HTTP (Voice PE)
- Long-term user profile in SQLite via `remember`/`recall`/`forget`
- `ask` tool — clarifying questions surface as `continue_conversation`
  in the HTTP `/text` response, which the HA bridge forwards into the
  Assist pipeline to reopen the mic without a new wake-word
- Auto-update on the Pi via GitHub Actions + GHCR: `main` builds an
  arm64 image, a daily systemd timer pulls and restarts with
  healthcheck-gated rollback and Telegram notification
- Single-process entry point: `node src/cli/unified.ts` routes by
  `AGENT_MODE` (default `both` = `telegram` + `http`)
- Telegram bot accepts text, voice (transcribed via OpenAI), and photos
  (multimodal). Authorised by an allow-list of chat IDs.
- Scheduled actions: `schedule_action` tool persists one-shot
  (wall-clock) or recurring (cron) goals; a tick-based scheduler fires
  them through a goal-mode agent with the full tool surface.
- **ru-meters-bot** — separate repo
  ([github.com/maxmaxme/ru-meters-bot](https://github.com/maxmaxme/ru-meters-bot))
  that submits monthly readings to Russian utility portals.

## Requirements

- Node.js 24+ (native TypeScript stripping; no build step)
- A reachable Home Assistant instance (the Pi prod stack via Tailscale,
  or a local one you run yourself)
- OpenAI API key

## Quick start

```bash
# 1. Node deps
npm install

# 2. .env
cp .env.example .env
# Fill HA_URL, HA_TOKEN, OPENAI_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,
# HTTP_API_KEYS.

# 3. Sanity check — list HA's MCP tools
npm run mcp:call -- list

# 4. Run
npm run start             # default — telegram + http (AGENT_MODE=both)
npm run telegram          # telegram only
npm run http              # http only

# AGENT_MODE valid values: telegram | http | both.
```

### Telegram bot

The agent runs a Telegram bot that accepts text, voice, and photo input.

Setup:

1. Create a bot via [@BotFather](https://t.me/BotFather) and copy the token.
2. Find your chat ID by messaging the bot once and running:

   ```bash
   curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates" \
     | jq '.result[].message.chat.id' | sort -u
   ```

3. Set in `.env`:

   ```
   TELEGRAM_BOT_TOKEN=...
   TELEGRAM_CHAT_ID=123456789
   TELEGRAM_ALLOWED_CHAT_IDS=123456789      # comma-list, optional (defaults to TELEGRAM_CHAT_ID)
   ```

4. `npm run start` runs the bot alongside the HTTP server. Or
   `AGENT_MODE=telegram npm run start` for bot-only.

Commands: `/start`, `/help`, `/reset`, `/profile`, `/update`.

### HTTP

The HTTP server exposes:

- `POST /text` — Apple Shortcut style. `Content-Type:
application/x-www-form-urlencoded`, form field `text`. Returns
  `{response}`. One-shot, no follow-up handling.
- `POST /audio` — raw audio bytes (Content-Type derives the format).
  Used by Apple Shortcut. Transcribes via OpenAI then runs the agent.
  Returns `{response, transcript}`.
- `POST /assist` — HA Assist / Voice PE via the
  `voice_assistant_bridge` integration (in `home-infra`).
  `Content-Type: application/json`, body `{"text": "..."}`. The agent
  uses the voice-addendum system prompt (TTS-friendly output) and
  `expectsFollowUp` is forwarded as `continue_conversation` so HA
  reopens the mic without a wake-word. Returns
  `{response, continue_conversation}`.
- `GET /health` — `{status: "ok"}` for healthchecks.

All non-health endpoints require `Authorization: Bearer <key>` against
`HTTP_API_KEYS` (comma-separated allowlist).

## Tests

```bash
npm test                       # unit tests
RUN_INTEGRATION=1 npm test     # also runs the MCP integration test (needs live HA)
npm run typecheck              # tsc --noEmit
```

## Deployment

The image built from this repo (`Dockerfile`) is published to
`ghcr.io/maxmaxme/voice-assistant` on every push to `main`. Host-side
compose, systemd units, and monitoring live outside this repo (in the
sibling `home-infra` repo).

## Docs

- Design spec: [docs/superpowers/specs/2026-04-25-voice-assistant-design.md](docs/superpowers/specs/2026-04-25-voice-assistant-design.md)
- Iteration plans: [docs/superpowers/plans/](docs/superpowers/plans/)
- HA setup guide: [docs/home-assistant-setup.md](docs/home-assistant-setup.md)
- iPhone Shortcuts integration: [docs/iphone-shortcuts.md](docs/iphone-shortcuts.md)
- Future ideas: [docs/superpowers/roadmap.md](docs/superpowers/roadmap.md)
- Architecture for contributors / agents: [CLAUDE.md](CLAUDE.md)
