# voice-assistant

Personal voice assistant for smart-home control. Targets a Raspberry Pi 5
runtime, developed on macOS. Cloud-heavy stack: OpenAI for STT
(`gpt-4o-transcribe`), LLM (`gpt-4o`), and TTS (`gpt-4o-mini-tts`); Home
Assistant via the official MCP Server integration; local
[openWakeWord](https://github.com/dscripka/openWakeWord) for wake-word
detection.

## Status

Iterations 1-4 + Memory Level 1 done. Pi deployment artifacts (Iter 5)
shipped: `deploy/Dockerfile`, `deploy/docker-compose.yml` (HA bundled),
`deploy/install.sh`. Live testing on Pi pending.

Working features:

- HA control via natural language (text and voice channels)
- Wake-word + VAD always-listening pipeline (English builtins; Russian
  via custom-trained `.onnx`)
- Long-term user profile in SQLite via `remember`/`recall`/`forget`
- Barge-in (interrupt the assistant by saying the wake word again)
- Explicit follow-up via the `ask` tool — clarifying questions reopen
  capture without another wake word
- Silent confirmation chime for simple actions ("turn on the light" → 🔔)
- Auto-update on the Pi via GitHub Actions + GHCR: `main` builds an
  arm64 image, a daily systemd timer pulls and restarts with
  healthcheck-gated rollback and Telegram notification
- Single-process, multi-channel entry point: `node src/cli/unified.ts`
  routes by `AGENT_MODE`. Old `chat.ts`/`voice.ts`/`run.ts` are now thin
  shims over it.
- Telegram bot accepts inbound text (polling). The agent answers in the
  same chat. Authorised by an allow-list of chat IDs.
- Scheduled actions: `schedule_action` tool persists one-shot
  (wall-clock) or recurring (cron) goals; a tick-based scheduler fires
  them through a goal-mode agent with the full tool surface.

## Requirements

- Node.js 24+ (native TypeScript stripping; no build step)
- macOS or Linux ARM64
- Python 3.10+ in `.venv` for the wake-word daemon
- `sox` (mic capture on macOS): `brew install sox`
- Docker (for Home Assistant in dev / Pi prod)
- OpenAI API key

## Quick start (macOS dev)

```bash
# 1. System deps
brew install sox

# 2. Node deps
npm install

# 3. Python deps for wake-word
python3 -m venv .venv
.venv/bin/pip install openwakeword

# 4. Home Assistant in Docker
docker compose -f docker/docker-compose.yml up -d
# Then follow docs/home-assistant-setup.md (manual onboarding,
# create LLAT, expose entities via WebSocket).

# 5. .env
cp .env.example .env
# Fill HA_URL=http://localhost:8123, HA_TOKEN, OPENAI_API_KEY.

# 6. Sanity check — list HA's MCP tools
npm run mcp:call -- list

# 7. Try the channels
npm run chat              # text REPL (AGENT_MODE=chat)
npm run voice             # push-to-talk (AGENT_MODE=voice)
npm run start             # default — all enabled channels at once (AGENT_MODE=both)
npm run start:wake        # always-listening daemon only (AGENT_MODE=wake)

# AGENT_MODE picks the runner(s). Valid: chat | voice | wake | telegram | http | both.
# Default for `npm run start` is `both`: wake-word, Telegram, and HTTP.
```

### Telegram bot (text)

The agent runs a Telegram bot that accepts text commands. Outbound messages
(via the `send_to_telegram` tool) already worked; this is the inbound side.

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

4. `npm run start` (default `AGENT_MODE=both`) runs the bot alongside the
   wake-word listener and HTTP endpoint. Or `AGENT_MODE=telegram npm run start`
   for bot-only.

Commands: `/start`, `/help`, `/reset`, `/profile`.

`WAKE_WORD_DEBUG=1` in `.env` makes the wake-word daemon print per-frame
diagnostics — useful when wake doesn't fire.

## Tests

```bash
npm test                       # unit tests
RUN_INTEGRATION=1 npm test     # also runs the MCP integration test (needs live HA)
npm run typecheck              # tsc --noEmit
```

## Pi deployment

```bash
# On a fresh Pi 5 with Raspberry Pi OS 64-bit:
sudo deploy/install.sh
# Edit /opt/voice-assistant/.env (HA_URL=http://home-assistant:8123, OPENAI key, etc.)
# Then:
cd /opt/voice-assistant/deploy && docker compose up -d
```

See [docs/raspberry-pi-setup.md](docs/raspberry-pi-setup.md) for
hardware notes, audio device selection, and troubleshooting.

## Docs

- Design spec: [docs/superpowers/specs/2026-04-25-voice-assistant-design.md](docs/superpowers/specs/2026-04-25-voice-assistant-design.md)
- Iteration plans: [docs/superpowers/plans/](docs/superpowers/plans/)
- HA setup guide: [docs/home-assistant-setup.md](docs/home-assistant-setup.md)
- Pi setup guide: [docs/raspberry-pi-setup.md](docs/raspberry-pi-setup.md)
- Future ideas: [docs/superpowers/roadmap.md](docs/superpowers/roadmap.md)
- Architecture for contributors / agents: [CLAUDE.md](CLAUDE.md)
