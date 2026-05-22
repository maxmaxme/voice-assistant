# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Personal voice assistant for smart-home control. Targets a Raspberry Pi 5
runtime, dev happens on macOS. Cloud-heavy stack: OpenAI for STT
(`gpt-4o-transcribe`) and the LLM (`gpt-4o`); Home Assistant via the
official MCP Server integration for device control. **Voice I/O is now
done by Voice PE smart speakers + Home Assistant's Assist pipeline** —
this service no longer captures audio locally. HA forwards each user
utterance (after its own STT) to the HTTP `/text` endpoint via a custom
`voice_assistant_bridge` integration that lives in the sibling
`home-infra` repo.

## Commands

```bash
npm install                        # plain — no native audio modules anymore
npm run typecheck                  # tsc --noEmit; allowImportingTsExtensions
npm test                           # vitest run, all unit tests
npm run test:watch                 # vitest watch mode
npm run lint                       # eslint (flat config: eslint.config.js)
npm run format                     # prettier --write .
npx vitest run path/to/file.test.ts -t "name"   # one test
RUN_INTEGRATION=1 npm test         # also runs tests gated against a live HA on http://localhost:8123

npm run mcp:call -- list           # list HA's MCP tools (sanity check)
npm run mcp:call -- call HassTurnOn '{"name":"Kitchen Light"}'

npm run start                      # default — telegram + http (AGENT_MODE=both)
npm run telegram                   # telegram only
npm run http                       # http only
```

`AGENT_MODE` values: `telegram` | `http` | `both`. Default `both`.

The Pi host stack (docker compose, systemd units, update.sh, monitoring,
HA bridge component) lives in the separate `home-infra` repo. The image
built from this repo (`Dockerfile` at the root) is published to
`ghcr.io/maxmaxme/voice-assistant` by CI and pulled from there by the Pi.

## Critical conventions (will bite you if ignored)

**Node 24 native TypeScript stripping, no build step.** All scripts run
`.ts` directly via `node src/cli/foo.ts`. There is no `tsc` build,
no `dist/`, no `tsx`. Two consequences:

1. **Relative imports use `.ts` extensions**, not `.js`: `import { x } from './foo.ts'`. Package imports keep `.js` where the package ships JS (e.g. `@modelcontextprotocol/sdk/client/index.js`).
2. **No TypeScript parameter properties**. Strip-only mode rejects `constructor(private readonly x: T)`. Declare the field explicitly and assign in the body. Likewise no `enum`, no `namespace`, no decorators.

`tsconfig.json` has `noEmit: true` + `allowImportingTsExtensions: true` to match. `npm run typecheck` is the only thing that touches `tsc`.

**Adapter pattern for every external dependency.** Each external concern lives behind an interface in `*/types.ts`, with a concrete implementation in a sibling file. Replacing OpenAI with a local Whisper is one new adapter — never a code-wide refactor. Honour this when adding anything that talks to the outside world.

**One process, two channels.** `src/cli/unified.ts` is the single entry. The only runners are `telegram` and `http`; `AGENT_MODE=both` runs them concurrently. Adding a new channel = adding a runner under `src/cli/runners/` and a case in the `dispatch()` switch.

**Git hooks via husky.** `pre-commit` runs `lint-staged` (prettier + eslint --fix on staged files only). `pre-push` runs `npm run typecheck && npm test`. Hooks install on `npm install` via the `prepare` script. Don't bypass with `--no-verify` to "make it work" — fix the underlying issue.

## Architecture

Two channels, one process.

### Entry points (`src/cli/`)

| File                          | What                                                                                                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/cli/mcp-call.ts`         | One-shot MCP CLI: list tools or call one. Useful for verifying HA connectivity.                                                                                    |
| `src/cli/unified.ts`          | **The entry point.** Reads `AGENT_MODE` and runs the matching runner(s).                                                                                           |
| `src/cli/runners/telegram.ts` | Telegram bot loop: receiver → agent → sender.                                                                                                                      |
| `src/cli/runners/http.ts`     | HTTP server using h3 (default port 3000, customizable via `HTTP_SERVER_PORT`). `POST /audio`, `POST /text`, `POST /assist`, `GET /health`. See HTTP section below. |

All runners share the same `OpenAiAgent` core.

### Logging (`src/utils/logger.ts`)

`pino` is used for diagnostic/server-side logging. Each module gets a child
logger via `createLogger('scope', { …bindings })`; output is written through
`process.stderr.write` so existing `stderr`-spy-based tests keep working.
Level is `info` by default, override via `LOG_LEVEL` env (`debug` / `info` /
`warn` / `error` / `fatal` / `silent`).

When stderr is a TTY (local dev), output is auto-prettified via
`pino-pretty`. Otherwise (Pi, Docker, CI) it's raw JSON one line per record.
Tests run under vitest get raw JSON regardless of TTY.

Per-request context is added via child loggers, e.g. the Telegram runner
does `log.child({ chatId, updateId, kind })` for every inbound update.

In tests, log output is silenced by default (`tests/setup.ts` pins
`rootLogger.level = 'silent'`). Tests that need to inspect logs use
`captureLogs()` from `tests/helpers/captureLogs.ts`.

### Agent core (`src/agent/`)

Uses the **OpenAI Responses API** (`client.responses.create`), not Chat Completions. Conversation state lives **server-side** at OpenAI — we keep only the `lastResponseId` locally in `Session` and chain turns via `previous_response_id`.

`OpenAiAgent.respond(userText)` runs the tool-calling loop:

1. `Session.begin()` returns the previous `response_id` to chain from, or `undefined` if the session is fresh / went idle.
2. On a fresh chain: send `instructions` (system prompt + memory profile) once. On a continuing chain: omit `instructions`.
3. Build tool list: HA MCP tools + memory tools (`remember`/`recall`/`forget`) + scheduled-action tools + `send_to_telegram` + (for HTTP only) the `ask` tool.
4. Send `input` (user message on first call, `function_call_output` items on tool-loop iterations) with `previous_response_id` and `store: true`.
5. Inspect `response.output` for `function_call` items; route by name:
   - `ask` is **terminal**: returns immediately with `expectsFollowUp: true`. The HTTP runner forwards that as `continue_conversation: true` in the JSON response; the HA bridge sets it on `ConversationResult`, and HA's Assist pipeline reopens the mic.
     - Disabled on Telegram (the model just asks via `speak` instead — avoids chain-lock if the user walks away).
     - If the model emits `ask` _in parallel_ with other tools, the other tools are executed and their outputs are stashed on the session; the next user turn replays them along with the user's answer.
     - `pendingAskCallId` has a TTL (`PENDING_ASK_TTL_MS = 30s`). If the user takes longer than that to reply, the next message is treated as a fresh request — the ask's call_id is closed with a placeholder output to keep the chain valid.
   - Memory / scheduled-action tools execute locally against the SQLite adapter.
   - `send_to_telegram` goes to the `TelegramSender`.
   - Everything else goes to MCP.
6. Loop, advancing `previousResponseId` to `response.id` each turn, until plain text comes back or `maxToolIterations` is hit.
7. On success → `Session.commit(response.id)`. On thrown error → no commit, so the next turn naturally starts fresh from the last successful chain point.

**Tool schemas:** local tools (memory/ask/telegram) are strict-by-default (Responses default `strict: true`) and include `additionalProperties: false`. HA MCP tools come from upstream and don't satisfy strict-mode requirements, so `mcpToolsToOpenAi` sets `strict: false` for them.

`memory: MemoryAdapter` is **required** on `OpenAiAgentOptions`. Tests that don't care about persistent state pass `emptyMemory()` (no-op).

**Prompt text lives in markdown files**, not in TS string literals. `src/agent/systemPrompt.ts` and friends just `fs.readFileSync` a sibling `.md` at module load (helper: `src/agent/prompts/load.ts::loadPrompt`). Layout:

- `src/agent/prompts/base-system.md` — cross-cutting rules (identity, HA error-recovery procedure, composite-intent self-check, style, JSON output shape). Loaded as `BASE_SYSTEM_PROMPT`.
- `src/agent/prompts/tools/{remember,recall,forget,schedule-action,list-scheduled,cancel-scheduled}.md` — descriptions for local tools we control.
- `src/agent/prompts/ha-suffix/<HaToolName>.md` — per-tool suffix appended to upstream HA MCP tool descriptions in `toolBridge.ts::mcpToolsToOpenAi`.
- `src/cli/prompts/text-format-addendum.md` — JSON output contract appended to every channel's system prompt.

When adding a new tool with tool-specific rules, put those rules in a sibling `.md` file rather than expanding `base-system.md`. Cross-tool rules (e.g. "after an HA match-failed error, do X") still go in `base-system.md`.

### Memory (`src/memory/`)

Long-term user profile. SQLite via `better-sqlite3`. `MemoryAdapter` interface; `SqliteProfileMemory` implementation; migrations live as **TS string constants** in `migrations.ts`. The runner skips migrations whose version is already in `schema_version` so DDL like `ALTER TABLE ADD COLUMN` is safe on repeated opens.

### Scheduled actions

The agent has a single `schedule_action(goal, schedule_kind, schedule_expr)` tool. Two forms:

- **One-shot**: `schedule_kind: 'once'` + a wall-clock string in the server timezone (`"2026-04-27 09:00"`).
- **Recurring**: `schedule_kind: 'cron'` + a POSIX 5-field cron string evaluated in the server timezone (`"0 8 * * *"`).

At fire time the scheduler spawns a fresh `OpenAiAgent.respond()` in **goal mode** (no `ask` tool, fresh `Session`) with the goal as the user message.

Persistence: SQLite table `scheduled_actions`. Cron rows reschedule themselves; once rows transition to `done` (or `error`).

Server timezone: `process.env.TZ` (IANA name, e.g. `Europe/Madrid`). The `[unified] AGENT_MODE=… TZ=… [WEB_SEARCH=on]` startup line confirms what's active.

`Scheduler.tick()` runs every 15 s, processes due rows in series, and is re-entrancy-guarded so a slow goal can't cause overlapping fires.

### Telegram (`src/telegram/`)

Bidirectional. **Outbound:** `TelegramSender` interface, `BotTelegramSender`
posts to `https://api.telegram.org/bot<token>/sendMessage`. Wired into the
agent as the `send_to_telegram` tool.

**Inbound:** `TelegramReceiver` interface, `PollingTelegramReceiver` long-polls
`getUpdates`. Persisted offset in `data/telegram-offset.json`. Voice messages
get transcribed via OpenAI; photos are forwarded as multimodal input.

Each chat has a self-persisting `Session` (SQLite table `telegram_sessions`)
with `idleTimeoutMs: Infinity` — the chain only resets via `/reset` or when
OpenAI evicts the `previous_response_id` (then `OpenAiAgent.respond` catches
the 404 and retries fresh).

Allow-list via `TELEGRAM_ALLOWED_CHAT_IDS`. Commands: `/start`, `/help`,
`/reset`, `/profile`, `/update`.

### HTTP (`src/cli/runners/http.ts`)

h3-based server. Three POST endpoints share auth + rate-limits but split
on agent flavour and response shape:

- `POST /audio` — raw audio bytes (Content-Type derives the format).
  Transcribed via `OpenAiStt` then run through the **plain** agent.
  Returns `{response, transcript}`. Used by Apple Shortcut.
- `POST /text` — `{text}` JSON or `text/plain`. Run through the **plain**
  agent. Returns `{response}`. Used by Apple Shortcut / other one-shot
  clients.
- `POST /assist` — text in (same shape as `/text`). Run through the
  **assist** agent: voice-addendum system prompt (TTS-friendly output),
  `ask` tool enabled. Returns `{response, continue_conversation}`. The
  HA bridge in `home-infra` reads `continue_conversation` and sets it
  on the `ConversationResult` so HA's Assist pipeline reopens the mic
  without a new wake-word. Used exclusively by Voice PE through HA.
- `GET /health` — `{status: "ok"}`.

The plain vs assist split is enforced by two separate `OpenAiAgent`
instances passed into the runner — they differ in `enableAsk` and in
the channel's system prompt (see `buildAgent` / `buildSystemPromptFor`
in [src/cli/shared.ts](src/cli/shared.ts)).

Auth: `Authorization: Bearer <key>` against `HTTP_API_KEYS`. Two
rate-limit layers: per-IP for failed auths (10 / 5 min) and per-token
(30 / min). `/audio` also has a concurrency semaphore (2) to bound
Whisper spend on a Pi.

### MCP client (`src/mcp/haMcpClient.ts`)

Wraps `@modelcontextprotocol/sdk` Streamable HTTP transport with Bearer auth against HA's `/api/mcp`. Single replaceable adapter — the `McpClient` interface is the contract used by everything else.

### Deployment & auto-update

Host-side artifacts (docker compose, systemd units, `update.sh`,
monitoring, HA bridge component) live in the separate `home-infra`
repo, cloned to `/opt/home-infra/` on the Pi. This repo only owns the
**image build**: CI cross-builds an arm64 image on every push to `main`
from the root `Dockerfile` and publishes it to
`ghcr.io/maxmaxme/voice-assistant`. The Pi pulls via
`/opt/home-infra/update.sh`, run by `voice-assistant-update.timer` at
04:00 daily or manually via `/update` Telegram command.

**FIFO for `/update`:** the container writes to `/tmp/va-update`, mounted
from the host. The host-side `va-update-listener.service` reads it and
invokes `update.sh`. No docker socket inside the container.

## ru-meters-bot — external sibling service

A separate one-shot Node service that submits monthly meter readings to
Russian utility portals via their JSON REST APIs. Lives in its own repo
at `~/Developer/ru-meters-bot/`. The voice-assistant runtime does NOT
import from it. Its docker-compose entry + systemd timer live in the
`home-infra` repo.

## Home Assistant — gotchas

The MCP integration only sees entities that are **exposed to Assist**. The UI toggle in HA 2026.x silently desyncs entity-registry from `homeassistant.exposed_entities`. Use the WebSocket service `homeassistant/expose_entity` from `docs/home-assistant-setup.md`.

## Project history & where things are decided

- `docs/superpowers/specs/` — design docs
- `docs/superpowers/plans/` — TDD-style implementation plans
- `docs/superpowers/roadmap.md` — backlog. Iteration history reflects the
  prior wake-word / FSM / local-mic generation; the current generation is
  Voice PE + HA bridge + HTTP.

## Keep this file up to date

This file is an onboarding shortcut for the next Claude (or human)
touching the repo. It rots fast if no one tends it. **When you make a
change that invalidates anything above, update this file in the same
commit** — don't punt to "later".

A useful rule of thumb: if you changed `package.json`, `tsconfig.json`,
the shape of any `*/types.ts`, or a CLI entry point, re-skim this
file and the README before committing.
