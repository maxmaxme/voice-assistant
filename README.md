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
- Silent confirmation chime for simple actions ("включи свет" → 🔔)

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
npm run chat        # text REPL
npm run voice       # push-to-talk (Enter to start/stop)
npm run start       # always-listening daemon (wake-word + VAD)
```

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
