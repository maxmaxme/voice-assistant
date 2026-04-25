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

## Critical conventions (will bite you if ignored)

**Node 24 native TypeScript stripping, no build step.** All scripts run
`.ts` directly via `node src/cli/foo.ts`. There is no `tsc` build,
no `dist/`, no `tsx`. Two consequences:

1. **Relative imports use `.ts` extensions**, not `.js`: `import { x } from './foo.ts'`. Package imports keep `.js` where the package ships JS (e.g. `@modelcontextprotocol/sdk/client/index.js`).
2. **No TypeScript parameter properties**. Strip-only mode rejects `constructor(private readonly x: T)`. Declare the field explicitly and assign in the body. Likewise no `enum`, no `namespace`, no decorators.

`tsconfig.json` has `noEmit: true` + `allowImportingTsExtensions: true` to match. `npm run typecheck` is the only thing that touches `tsc`.

**Adapter pattern for every external dependency.** Each external concern lives behind an interface in `*/types.ts`, with a concrete implementation in a sibling file. Replacing OpenAI with a local Whisper, or `aplay` with `speaker`, is one new adapter — never a code-wide refactor. Honour this when adding anything that talks to the outside world.

**`speaker` npm is platform-conditional.** Its bundled mpg123 doesn't compile on Node 24 Linux. `NodeSpeakerOutput` (in `src/audio/speakerOutput.ts`) spawns `aplay` on Linux and dynamic-imports `speaker` on macOS. `speaker` is in `optionalDependencies` so a failed compile in the Pi container doesn't fail `npm ci`.

## Architecture

Three layers, four entry points.

### Entry points (`src/cli/`)

| File | What |
|---|---|
| `mcp-call.ts` | One-shot MCP CLI: list tools or call one. Useful for verifying HA connectivity. |
| `chat.ts` | Text REPL → LLM → MCP. No audio. |
| `voice.ts` | Push-to-talk: Enter starts/stops recording. STT → agent → TTS. |
| `run.ts` | Always-listening daemon. Wake-word → VAD → STT → agent → TTS. The "production" entry. |

All four share the same `OpenAiAgent` core. The voice/run entries add audio adapters and (for `run.ts`) the orchestrator FSM.

### Agent core (`src/agent/`)

`OpenAiAgent.respond(userText)` runs the tool-calling loop:

1. Refresh system prompt (injects current memory profile).
2. Append user message to `ConversationStore`.
3. Build tool list: HA MCP tools + memory tools (`remember`/`recall`/`forget`) + the local `ask` tool.
4. Call OpenAI; if tool calls come back, route by name:
   - `ask` is **terminal**: returns immediately with `expectsFollowUp: true` so the orchestrator reopens capture.
   - Memory tools execute locally against the `MemoryAdapter`.
   - Everything else goes to MCP.
5. Loop until LLM returns plain text or `maxToolIterations` is hit.
6. **Transactional rollback**: on any thrown error, restore `ConversationStore` to the pre-turn snapshot so a half-applied turn doesn't poison subsequent calls.

`ConversationStore.trim()` never strands a `tool` message or
`assistant(tool_calls)` at the head — OpenAI rejects orphaned tool sequences, so we walk forward off them after slicing. Don't break this in refactors.

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

Outbound channel for delivering text to the user. `TelegramSender`
interface; `BotTelegramSender` posts to
`https://api.telegram.org/bot<token>/sendMessage`. Wired into the agent
as the `send_to_telegram` tool. `TELEGRAM_BOT_TOKEN` and
`TELEGRAM_CHAT_ID` are required env vars — `loadConfig()` throws without
them. Use the `telegramFromConfig()` helper when constructing the agent.

### MCP client (`src/mcp/haMcpClient.ts`)

Wraps `@modelcontextprotocol/sdk` Streamable HTTP transport with Bearer auth against HA's `/api/mcp`. Single replaceable adapter — the `McpClient` interface is the contract used by everything else.

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

A useful rule of thumb: if you changed `package.json`, `tsconfig.json`,
the shape of any `*/types.ts`, or a CLI entry point, re-skim this
file and the README before committing.
