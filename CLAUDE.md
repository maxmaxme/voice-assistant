# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Personal voice assistant for smart-home control. Targets a Raspberry Pi 5
runtime, dev happens on macOS. Cloud-heavy stack: OpenAI for STT
(`gpt-4o-transcribe`), LLM (`gpt-4o`), and TTS (`gpt-4o-mini-tts`); Home
Assistant via the official MCP Server integration for device control;
local Porcupine-style wake-word via `openwakeword` running as a Python
subprocess.

## Commands

```bash
npm install                        # also runs (and may fail on) optional `speaker` build — that's expected on Linux
npm run typecheck                  # tsc --noEmit; allowImportingTsExtensions
npm test                           # vitest run, all unit tests
npm run test:watch                 # vitest watch mode
npm run lint                       # eslint (flat config: eslint.config.js)
npm run format                     # prettier --write .
npm run test:shell                 # bats tests for deploy/update.sh
npx vitest run path/to/file.test.ts -t "name"   # one test
RUN_INTEGRATION=1 npm test         # also runs tests gated against a live HA on http://localhost:8123

npm run mcp:call -- list           # list HA's MCP tools (sanity check)
npm run mcp:call -- call HassTurnOn '{"name":"Свет на кухне"}'

npm run chat                       # text REPL — type commands, agent calls HA tools
npm run voice                      # push-to-talk (Enter to start/stop recording)
npm run start                      # always-listening daemon (wake-word + VAD + FSM)

# Dev HA in Docker (Mac, colima):
docker compose -f docker/docker-compose.yml up -d

# Pi prod stack (HA bundled in same compose):
docker compose -f deploy/docker-compose.yml up -d
```

`WAKE_WORD_DEBUG=1` in `.env` makes the wake-word daemon print per-frame
max score and RMS to stderr — invaluable when wake doesn't fire.

`npm run test:shell` requires `bats-core`: `brew install bats-core` on
macOS, `apt-get install bats` on the Pi.

## Critical conventions (will bite you if ignored)

**Node 24 native TypeScript stripping, no build step.** All scripts run
`.ts` directly via `node src/cli/foo.ts`. There is no `tsc` build,
no `dist/`, no `tsx`. Two consequences:

1. **Relative imports use `.ts` extensions**, not `.js`: `import { x } from './foo.ts'`. Package imports keep `.js` where the package ships JS (e.g. `@modelcontextprotocol/sdk/client/index.js`).
2. **No TypeScript parameter properties**. Strip-only mode rejects `constructor(private readonly x: T)`. Declare the field explicitly and assign in the body. Likewise no `enum`, no `namespace`, no decorators.

`tsconfig.json` has `noEmit: true` + `allowImportingTsExtensions: true` to match. `npm run typecheck` is the only thing that touches `tsc`.

**Adapter pattern for every external dependency.** Each external concern lives behind an interface in `*/types.ts`, with a concrete implementation in a sibling file. Replacing OpenAI with a local Whisper, or `aplay` with `speaker`, is one new adapter — never a code-wide refactor. Honour this when adding anything that talks to the outside world.

**One process, many channels.** `src/cli/unified.ts` is the single entry. Adding a new input channel = adding a runner under `src/cli/runners/` and a case in the `dispatch()` switch — never another top-level entry script. Per-channel system-prompt addenda live in `src/cli/shared.ts::buildSystemPromptFor`.

**`speaker` npm is platform-conditional.** Its bundled mpg123 doesn't compile on Node 24 Linux. `NodeSpeakerOutput` (in `src/audio/speakerOutput.ts`) spawns `aplay` on Linux and dynamic-imports `speaker` on macOS. `speaker` is in `optionalDependencies` so a failed compile in the Pi container doesn't fail `npm ci`.

**Git hooks via husky.** `pre-commit` runs `lint-staged` (prettier + eslint --fix on staged files only). `pre-push` runs `npm run typecheck && npm test`. Hooks install on `npm install` via the `prepare` script. Don't bypass with `--no-verify` to "make it work" — fix the underlying issue.

## Architecture

Three layers, four entry points.

### Entry points (`src/cli/`)

| File                          | What                                                                                                                                                 |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/cli/mcp-call.ts`         | One-shot MCP CLI: list tools or call one. Useful for verifying HA connectivity.                                                                      |
| `src/cli/unified.ts`          | **The entry point.** Reads `AGENT_MODE` (chat / voice / wake / telegram / both) and runs the matching runner(s). `npm run start` defaults to `both`. |
| `src/cli/runners/chat.ts`     | Text REPL loop.                                                                                                                                      |
| `src/cli/runners/voice.ts`    | Push-to-talk: Enter starts/stops recording.                                                                                                          |
| `src/cli/runners/wake.ts`     | Always-listening: Wake-word → VAD → STT → agent → TTS.                                                                                               |
| `src/cli/runners/telegram.ts` | Telegram bot loop: receiver → agent → sender.                                                                                                        |
| `src/cli/{chat,voice,run}.ts` | Thin shims that set `AGENT_MODE` and re-import `unified.ts`. Kept for backward-compat.                                                               |

All share the same `OpenAiAgent` core. The voice/wake runners add audio adapters and the orchestrator FSM.

### Agent core (`src/agent/`)

Uses the **OpenAI Responses API** (`client.responses.create`), not Chat Completions. Conversation state lives **server-side** at OpenAI — we keep only the `lastResponseId` locally in `Session` and chain turns via `previous_response_id`.

`OpenAiAgent.respond(userText)` runs the tool-calling loop:

1. `Session.begin()` returns the previous `response_id` to chain from, or `undefined` if the session is fresh / went idle.
2. On a fresh chain: send `instructions` (system prompt + memory profile) once. On a continuing chain: omit `instructions` — the server still has them.
3. Build tool list: HA MCP tools + memory tools (`remember`/`recall`/`forget`) + the local `ask` and `send_to_telegram` tools.
4. Send `input` (user message on first call, `function_call_output` items on tool-loop iterations) with `previous_response_id` and `store: true`.
5. Inspect `response.output` for `function_call` items; route by name:
   - `ask` is **terminal**: returns immediately with `expectsFollowUp: true` so the orchestrator reopens capture.
   - Memory tools execute locally against the `MemoryAdapter`.
   - `send_to_telegram` goes to the `TelegramSender`.
   - Everything else goes to MCP.
6. Loop, advancing `previousResponseId` to `response.id` each turn, until plain text comes back or `maxToolIterations` is hit.
7. On success → `Session.commit(response.id)`. On thrown error → no commit, so the next turn naturally starts fresh from the last successful chain point.

**Tool schemas:** local tools (memory/ask/telegram) are strict-by-default (Responses default `strict: true`) and include `additionalProperties: false`. HA MCP tools come from upstream and don't satisfy strict-mode requirements, so `mcpToolsToOpenAi` sets `strict: false` for them.

`memory: MemoryAdapter` is **required** on `OpenAiAgentOptions`. Tests that don't care about persistent state pass `emptyMemory()` (no-op).

The system prompt is shared via `src/agent/systemPrompt.ts` (`BASE_SYSTEM_PROMPT`); voice channels append a one-sentence addendum about TTS-friendly output. Behavioural fixes go in the shared base unless they're truly channel-specific.

### Orchestrator FSM (`src/orchestrator/`)

States: `idle` / `listening` / `thinking` / `speaking`. Pure `transition(state, event, options)` — easy to test, no side effects. Side effects are described as data (`Effect[]`), executed by the runtime.

Key transitions:

- `idle + wake → listening` (start capture, play 🎵 listen-chime)
- `listening + utteranceEnd → thinking` (transcribe + ask agent)
- `thinking + agentReplied → speaking` (carries `expectsFollowUp` from agent)
- `speaking + wake → listening` (**barge-in**: stop TTS, capture)
- `speaking + speechFinished → idle` (or `→ listening` if `followUp` option set)
- `speaking + followUpRequested → listening` (always; `ask` tool was called)

Audio chimes:

- 🎵 ascending two-tone on every capture start (LISTEN_BLIP)
- 🔔 single decaying tone when LLM replies with literal `✓` (CONFIRM_BLIP); see `src/audio/blip.ts`. The `✓` shortcut keeps simple device-action acknowledgments silent.

### Wake-word (`src/audio/wakeWord.ts` + `scripts/wake_word_daemon.py`)

Originally Picovoice Porcupine; switched to **openWakeWord** because Picovoice no longer issues free personal AccessKeys. openWakeWord's pipeline (3 chained ONNX models + sliding window) is messy in pure Node, so the daemon is a tiny Python script we control via stdin/stdout JSON.

- Node spawns `python3 scripts/wake_word_daemon.py --keyword <name>`.
- 1280-sample (80 ms) frames go in via stdin (raw 16-bit LE PCM, mono, 16 kHz).
- Daemon emits `{"type":"ready",...}` on startup and `{"type":"wake","keyword":"...","score":...}` on detection.
- `WAKE_WORD_KEYWORD` accepts a builtin name (`hey_jarvis`, `alexa`, ...) **or** a path to a custom `.onnx` (e.g. `models/alisa.onnx` from the openWakeWord training notebook).
- `WAKE_WORD_PYTHON` overrides the interpreter path: `.venv/bin/python` locally, `/usr/bin/python3` in the container.

### Memory (`src/memory/`)

Long-term user profile. SQLite via `better-sqlite3`. `MemoryAdapter` interface; `SqliteProfileMemory` implementation; migrations live as **TS string constants** in `migrations.ts` (not `.sql` files — there's no build step to copy them into a container).

The current profile is injected into the system prompt on every turn via `OpenAiAgent.buildSystemMessage()`.

Out of scope (see `docs/superpowers/roadmap.md`): episodic memory (vector search), procedural memory (learned habits).

### Telegram (`src/telegram/`)

Bidirectional. **Outbound:** `TelegramSender` interface, `BotTelegramSender`
posts to `https://api.telegram.org/bot<token>/sendMessage`. Wired into the
agent as the `send_to_telegram` tool.

**Inbound:** `TelegramReceiver` interface, `PollingTelegramReceiver` long-polls
`getUpdates` (timeout 30s) and emits typed `TelegramMessage` events
(`text` / `voice` / `unsupported`). The persisted `update_id` lives in
`data/telegram-offset.json` so restarts don't replay history. The runner
`src/cli/runners/telegram.ts` wires the receiver to a per-channel
`OpenAiAgent`, applies the `TELEGRAM_ALLOWED_CHAT_IDS` allow-list, handles
`/reset` / `/profile` / `/start` locally, and forwards everything else.

Voice messages currently reply "not supported yet"; transcription is a
follow-up plan.

Required env vars: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`. Optional:
`TELEGRAM_ALLOWED_CHAT_IDS` (comma list of integer chat ids; defaults to
`TELEGRAM_CHAT_ID`).

### MCP client (`src/mcp/haMcpClient.ts`)

Wraps `@modelcontextprotocol/sdk` Streamable HTTP transport with Bearer auth against HA's `/api/mcp`. Single replaceable adapter — the `McpClient` interface is the contract used by everything else.

### Deployment & auto-update (`deploy/`)

CI (`.github/workflows/build-image.yml`) cross-builds an arm64 image on every push to `main` and publishes it to `ghcr.io/maxmaxme/voice-assistant`. The Pi pulls via `deploy/update.sh`, run by `voice-assistant-update.timer` at 04:00 daily. The script bails when the digest hasn't changed, rolls back to the previous image if the existing healthcheck doesn't go green within 90 s, and posts the outcome to the same Telegram bot the agent uses. There is no blue/green: a single ALSA mic forces a serial restart, and 5 s of unavailability at 04:00 is invisible.

## Home Assistant — gotchas

The MCP integration only sees entities that are **exposed to Assist**. The UI toggle in HA 2026.x silently desyncs entity-registry from `homeassistant.exposed_entities`. Use the WebSocket service `homeassistant/expose_entity` from `docs/home-assistant-setup.md` — that's the canonical path.

Mock entities for testing live in `docker/homeassistant/configuration.yaml`: real `light.*` / `switch.*` template entities backed by hidden `input_boolean.*_state` helpers. Adding mocks: edit YAML, restart container, expose via WS.

## Project history & where things are decided

- `docs/superpowers/specs/` — design docs (one big up-front, plus per-feature)
- `docs/superpowers/plans/` — TDD-style implementation plans, one per iteration. Iterations 1-4 + Memory Level 1 are done; Iteration 5 (Pi deployment) was reduced to deployment artifacts in `deploy/`.
- `docs/superpowers/roadmap.md` — backlog of deferred wishes (acoustic echo cancellation, custom Russian wake-word, streaming TTS, episodic memory, etc.). When picking a new feature, start here, then groom into a spec + plan via the `superpowers:brainstorming` and `superpowers:writing-plans` skills.

The codebase was built iteration by iteration through TDD; tests are real and worth running. Don't loosen the conventions above to "make a quick fix work" — they're load-bearing.

## Keep this file up to date

This file is an onboarding shortcut for the next Claude (or human)
touching the repo. It rots fast if no one tends it. **When you make a
change that invalidates anything above, update this file in the same
commit** — don't punt to "later".

Specifically watch for:

- New conventions or constraints (e.g. a new build/runtime quirk, a
  new lint rule, a banned syntax form). The "Critical conventions"
  section is for these.
- New entry points, new top-level directories, or removal of existing
  ones. Update the architecture map.
- Shifts in adapter responsibilities (e.g. swapping `aplay` for
  `pulseaudio`, replacing OpenAI STT with Whisper). The behaviour of
  `OpenAiAgent.respond()`, the FSM transitions, and the wake-word
  daemon protocol are all called out — keep those descriptions
  honest.
- Iteration / roadmap status. When an iteration lands or a roadmap
  item gets implemented, reflect it in `README.md`'s Status section
  AND remove it from `docs/superpowers/roadmap.md`.
- Changes to the Telegram message types (`TelegramMessage` union) — keep
  the runner's switch exhaustive, and update the test that exercises each
  branch.

A useful rule of thumb: if you changed `package.json`, `tsconfig.json`,
the shape of any `*/types.ts`, or a CLI entry point, re-skim this
file and the README before committing.
