# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Personal voice assistant for smart-home control. Targets a Raspberry Pi 5
runtime, dev happens on macOS. Cloud-heavy stack: OpenAI for STT and the LLM;
Home Assistant via the official MCP Server integration for device control.
OpenAI, HA and Telegram are configured through the **web panel's Integrations**
(DB-backed), not env — OpenAI is mandatory, HA and Telegram are optional. See the
MCP client section.

Inputs into the agent core, and who actually drives each one today:

- **WS `/voice` (`:3001`) — the speaker.** Voice PE speakers connect
  directly over a WebSocket and use OpenAI's **Realtime API** for
  STT+LLM+TTS in one bidirectional session. HA is used only as an MCP
  tool backend. See "Realtime bridge" below.
- **HTTP `/text` + `/audio` (`:3000`) — iOS Shortcuts.** Text and
  audio-file inputs go through the Responses-API `OpenAiAgent`. iOS
  Shortcuts is the current consumer; this is the channel most likely to
  grow more clients later. `/assist` also lives on this server but is
  the HA-bridge / HA-style-session path, not a Shortcuts input.
- **Telegram — chat with the bot.** Text / voice / photo into the same
  agent core.

This repo only owns the **server-side app** (Node/TS) and the image
build. Deployment (compose, systemd, healthchecks, rollback) lives
outside this repo and is none of this codebase's concern.

The `web/` subdir is a **separate Nuxt 4 SSR app** (its own image, its own
Nitro server) — a config panel that edits the `settings`, `prompts` and
`integrations` tables (apply on next restart) and manages `users` + `identities`
(applied live — auth reads them per request) in the same SQLite DB. The core
stays no-build; `web/` has its own toolchain. See `web/README.md` and the "Web
config" section below.

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

npm run start                      # the single entry; each channel self-gates (see below)

npm run users -- add-user --name Alex                          # create a principal (person or speaker)
npm run users -- attach-telegram --user <id> --chat <chatId>   # bind a Telegram chat to a user
npm run users -- attach-voice --user <id> --token <token>      # bind a speaker's device token (presented on the WS handshake)
npm run users -- mint-http --user <id>                         # mint an HTTP token (printed once; only its hash is stored)
```

There is no `AGENT_MODE`. Each channel self-gates from DB-backed web-panel
config, all applied on the next start:

- **Telegram** runs when a bot token is configured (integration) **and** the
  Telegram page toggle is on (`telegram.enabled`). Installing the integration
  alone does nothing.
- **HTTP** server always runs (so `/health` is always up — container
  healthcheck); each input endpoint mounts only when its toggle is on
  (`http.text` / `http.audio` on the HTTP API page, `http.assist` on the HA
  Assist page). A disabled endpoint 404s.
- **Realtime** runs when the HA Voice Realtime page toggle is on (`realtime.enabled`).

CI builds the root `Dockerfile` and publishes
`ghcr.io/maxmaxme/voice-assistant:latest` on every push to `main`.
Anything past the registry push (pull, restart, rollback, monitoring)
is not this repo's concern.

## Critical conventions (will bite you if ignored)

**Node 24 native TypeScript stripping, no build step.** All scripts run
`.ts` directly via `node src/cli/foo.ts`. There is no `tsc` build,
no `dist/`, no `tsx`. Two consequences:

1. **Relative imports use `.ts` extensions**, not `.js`: `import { x } from './foo.ts'`. Package imports keep `.js` where the package ships JS (e.g. `@modelcontextprotocol/sdk/client/index.js`).
2. **No TypeScript parameter properties**. Strip-only mode rejects `constructor(private readonly x: T)`. Declare the field explicitly and assign in the body. Likewise no `enum`, no `namespace`, no decorators.

`tsconfig.json` has `noEmit: true` + `allowImportingTsExtensions: true` to match. `npm run typecheck` is the only thing that touches `tsc`.

**Adapter pattern for every external dependency.** Each external concern lives behind an interface in `*/types.ts`, with a concrete implementation in a sibling file. Replacing OpenAI with a local Whisper is one new adapter — never a code-wide refactor. Honour this when adding anything that talks to the outside world.

**One process, self-gating channels.** `src/cli/unified.ts` is the single entry. `dispatch()` starts the `telegram` runner iff a token is configured AND `telegram.enabled`, and always starts the `http` runner (which mounts `/text` `/audio` `/assist` per-flag and always serves `/health`); the realtime server is started in `main()` iff `realtime.enabled`. No `AGENT_MODE` — each channel is independently toggled from the web panel. Adding a new channel = a runner under `src/cli/runners/` + its gate in `dispatch()`.

**Git hooks via husky.** `pre-commit` runs `lint-staged` (prettier + eslint --fix on staged files only). `pre-push` runs `npm run typecheck && npm test`. Hooks install on `npm install` via the `prepare` script. Don't bypass with `--no-verify` to "make it work" — fix the underlying issue.

## Architecture

Two channels, one process.

### Entry points (`src/cli/`)

| File                          | What                                                                                                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/cli/mcp-call.ts`         | One-shot MCP CLI: list tools or call one. Useful for verifying HA connectivity.                                                                                    |
| `src/cli/unified.ts`          | **The entry point.** Starts each channel that is independently enabled (`telegram.enabled` + token / per-endpoint `http.*` / `realtime.enabled`).                  |
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
3. Build tool list: HA MCP tools + the local-tool registry + (for HTTP only) the `ask` tool. **Local tools (`get_current_time`, memory `remember`/`recall`/`forget`, scheduled actions, `send_to_telegram`, weather) come from one registry — `localTools.ts::buildLocalToolset`** — shared with the realtime bridge: it both lists the tools and executes them. A tool registers only when its adapter is wired (the per-channel policy knob — goal mode just doesn't pass `scheduledActions`/`telegram`) **and** its built-in toggle is on. Memory / reminders / weather are gated by the **Tools page** (`resolveToolsConfig`, `src/settings/toolsConfig.ts`; keys `tools.*`; **on by default**, a stored `'0'` disables) — threaded as `OpenAiAgentOptions.tools` → `buildLocalToolset` `enableMemory`/`enableReminders`/`enableWeather`. Weather also takes config from there (units metric/imperial → Open-Meteo params; default-location fallback). `send_to_telegram` stays tied to the Telegram channel. **`get_current_time` is always on (adapter-free, no toggle):** the prompt carries **no static clock** — instructions are sent once per chain, so a baked-in timestamp goes stale (yesterday's date after midnight on a long-lived Telegram chain). The agent reads "now" / resolves relative dates (today, tomorrow, "in 5 min") on demand via this tool; weather + schedule_action descriptions and `base-system.md` tell it to call it first. Adding a local tool = adding one registry entry; `ask` is the only local tool outside it (terminal control flow, handled in the agent loop).
4. Send `input` (user message on first call, `function_call_output` items on tool-loop iterations) with `previous_response_id` and `store: true`.
5. Inspect `response.output` for `function_call` items; route by name:
   - `ask` is **terminal**: returns immediately with `expectsFollowUp: true`. The HTTP runner forwards that as `continue_conversation: true` in the JSON response; the HA bridge sets it on `ConversationResult`, and HA's Assist pipeline reopens the mic.
     - Disabled on Telegram (the model just asks in its reply text instead — avoids chain-lock if the user walks away).
     - If the model emits `ask` _in parallel_ with other tools, the other tools are executed and their outputs are stashed on the session; the next user turn replays them along with the user's answer.
     - `pendingAskCallId` has a TTL (`PENDING_ASK_TTL_MS = 30s`). If the user takes longer than that to reply, the next message is treated as a fresh request — the ask's call_id is closed with a placeholder output to keep the chain valid.
   - Names in the local-tool registry execute in-process via `localToolset.execute` (memory and scheduled actions hit the SQLite adapters).
   - `send_to_telegram(text, recipient?)` is recipient-aware: it resolves the target user (the `recipient` user id, or the current `scope.userId` when omitted) to a Telegram chat via `identities.identityFor('telegram', …)` and delivers there. No telegram linked → it throws an error listing valid recipients (`id=name`), which the model relays / re-asks. There is no fixed outbound chat.
   - Everything else goes to MCP.
6. Loop, advancing `previousResponseId` to `response.id` each turn, until plain text comes back or `maxToolIterations` is hit.
7. On success → `Session.commit(response.id)`. On thrown error → no commit, so the next turn naturally starts fresh from the last successful chain point.

**Streaming deltas.** `AgentRespondOptions.onTextDelta` streams output-text
deltas: when the callback is set, the agent uses `responses.stream(...)`
(listening on `response.output_text.delta`, awaiting `finalResponse()`)
instead of `responses.create`; the return value is identical. The callback
fires on every tool-loop iteration — including ones that end in tool calls —
so callers must treat deltas as ephemeral preview text (the Telegram runner
shows them as a draft superseded by the final message).

**Reasoning effort.** For reasoning-capable models (gpt-5 family, o-series), `OpenAiAgent` passes `reasoning.effort` from `config.openai.reasoningEffort` (env `OPENAI_REASONING_EFFORT`, default `low`). Non-reasoning models ignore the field server-side. Bump to `medium`/`high` for puzzle-heavy workloads; `low` is enough for tool routing and typical household requests.

**Tool schemas:** local tools (memory/ask/telegram) are strict-by-default (Responses default `strict: true`) and include `additionalProperties: false`. HA MCP tools come from upstream and don't satisfy strict-mode requirements, so `mcpToolsToOpenAi` sets `strict: false` for them.

`memory: MemoryAdapter` is **required** on `OpenAiAgentOptions`. Tests that don't care about persistent state pass `emptyMemory()` (no-op).

**Agent prompts are written in English.** Every prompt — system prompts, tool descriptions, and any prompt text injected at runtime — must be in English, even though users talk to the agent in any language (the prompts instruct the model to reply in the user's language). Keep examples in prompts English too; don't paste Russian sample phrases. This keeps prompts consistent and avoids biasing the model toward one language.

**Prompt text lives in markdown files, but is served from the DB at runtime.**
The bundled `.md` files are the source of truth for any prompt the user hasn't
customized; the **prompt registry** (`src/agent/prompts/registry.ts`) discovers
them by walking the prompt dirs and, at bootstrap, `seedWithDefault`s each into
the `prompts` table (`initPromptRegistry`) — storing the bundled text in
`default_content` (refreshed every start) and leaving `content` **empty**. Every
consumer reads via `resolvePrompt(name)`: a **non-empty** DB `content` (a real
web edit) wins, otherwise it falls back to the bundled file. **An empty `content`
is the "not customized" sentinel**, so an un-edited prompt always follows the
live code default instead of freezing a stale copy. The web panel writes that
sentinel whenever a saved edit matches the current default and on "Reset to
default"; it surfaces the effective text (`content || default_content`) so the
editor and "Modified" badge read correctly. So **all** prompts are DB-backed and
web-editable; edits apply on the **next process start**. Names are the
registry/DB keys and the labels shown in the web UI. Layout:

- `src/agent/prompts/base-system.md` → name `base-system` — **HA-agnostic** cross-cutting rules: identity (general personal assistant), the "fill sensible defaults, don't ask" rule, style. Always included.
- `src/agent/prompts/ha-addendum.md` → name `ha-addendum` — HA device-control rules (ACT-don't-ask, `GetLiveContext`, the error-recovery procedure, multi-tool device intent). `buildSystemPromptFor(channel, haEnabled)` appends it **only when HA is configured**, so a no-HA install gets a clean general-assistant prompt.
- `src/agent/prompts/tools/{remember,recall,forget,schedule-action,list-scheduled,cancel-scheduled}.md` → names `tools/<file>` — descriptions for local tools we control (`memoryTools.ts`, `scheduledActionTools.ts`).
- `src/agent/prompts/ha-suffix/<HaToolName>.md` → names `ha-suffix/<HaToolName>` — per-tool suffix appended to upstream HA MCP tool descriptions in `toolBridge.ts`.
- `src/cli/prompts/{voice,realtime}-addendum.md` → names `voice-addendum` / `realtime-addendum` — channel suffixes added by `buildSystemPromptFor`.

When adding a new tool with tool-specific rules, drop a sibling `.md` (it's
auto-discovered + seeded) and read it via `resolvePrompt`. Keep HA-specific
behaviour in `ha-addendum.md` (not `base-system.md`), so it only loads when HA
is on.

### Memory (`src/memory/`)

Long-term profile. SQLite via **Drizzle ORM** (synchronous `drizzle-orm/better-sqlite3` driver) behind the `MemoryAdapter` interface; tables are declared in `schema.ts` and each store (`SqliteProfileMemory` etc.) takes a Drizzle `Db`. Schema migrations are drizzle-kit `.sql` files under `drizzle/`, applied on open by `applyMigrations()` in `db.ts`: a fresh DB runs the `0000_init` snapshot; the pre-Drizzle prod DB (which has a `schema_version` table at v12 but no drizzle journal) is handled by a **baseline shim** that seeds `__drizzle_migrations` so `migrate()` skips `0000_init` without re-creating existing tables. Add a migration by editing `schema.ts` then `npm run db:generate`. The connection sets `journal_mode = WAL` + `busy_timeout = 5000` (`memoryStore.ts`) so a brief external write lock (e.g. an out-of-repo sqlite-web admin) doesn't make the app throw.

**Two memory scopes, DB-backed identities.** Memory is split into a shared
`household` scope and per-principal `personal` scopes. **Every principal — a
person OR a speaker — is uniform; there is no `member`/`shared` role.**

- **`profile` table** has an `owner` column with composite PK `(owner, key)`.
  `owner` is `'household'` or `'user:<id>'` (rows with no explicit owner
  default to `household`).
- **`users(id, name, created_at, is_admin)`** — principals (people and
  speakers). There is no `role` column — every principal is uniform.
- **`identities(id, channel, identity, user_id, created_at, last_used_at, UNIQUE(channel, identity))`**
  — `channel ∈ {telegram, http, voice}`. `identity` is a Telegram chatId
  (raw) or the **sha256 hash** of an HTTP/voice bearer token. Raw tokens are
  never stored (`identities.ts::hashToken`). `last_used_at` (nullable, v11) is
  stamped via `identities.touch(...)` on each successful authorization — once
  per request at each channel's auth chokepoint (`checkAuthAndRate` for HTTP,
  `resolveTelegramScope` for Telegram, `speakerProfile` for voice). `resolve()`
  stays a pure read; `NULL` means unused since v11.

**Scope is a property of the principal (user)** (`scope.ts`). A request's
identity resolves to a `userId` → `Scope = { userId }` → `makeScopedProfile`
gives a `ScopedProfile` (`recall`/`remember`/`forget`). The rule is the same
for everyone:

- **reads** `household ∪ personal(user)` — `personal` **overrides** household
  on key collision;
- **writes** `personal(user)` by default, `household` only when the call passes
  `scope: 'household'`.

`householdProfile` / `householdFromAdapter` give a **household-only** view
(reads/writes household, no personal) for principal-less callers — the goal
runner and the realtime fallback.

**`remember` tool** takes an optional `scope` enum (`personal`|`household`),
default `personal`. The model is told to pick `household` only for
clearly-shared facts and to ask when ambiguous (`prompts/tools/remember.md`).
`recall` always merges per the read rule above.

**`forget` is personal-first, not scope-pick.** `ScopedProfile.forget(key)`
deletes the layer the principal actually _sees_ — personal first, and household
only when there's no personal copy — so "forget X" can't silently wipe a shared
fact the user didn't realize was shared. It returns a `ForgetResult`
(`{ deleted, scope?, revealed? }`): `revealed: true` means a personal entry was
removed but a household entry with the same key was underneath and now surfaces
in `recall`. The `forget` tool has no `scope` arg; `executeMemoryTool` relays
the result so the model can phrase the reply accurately
(`prompts/tools/forget.md`). It never touches another principal's personal
owner (delete is exact-`(owner, key)`).

**Per-request scope resolution.** `OpenAiAgent.respond()` takes an optional
`profile: ScopedProfile` (falls back to a household view). The HTTP runner
resolves the Bearer token → `{ userId }` (`resolveHttpScope`), the Telegram
runner resolves the chatId (`resolveTelegramScope`), and the realtime WS
resolves the device token (`authorizeSpeaker` in `unified.ts`) — each passes the
scoped profile in. So your Telegram chat, your HTTP token, and the speaker each
read `household ∪ their own personal` and write personal by default; none sees
another principal's personal.

**Auth & scope are DB-backed. There is no env allow-list and no seed** —
identities are created and managed entirely via the `users` CLI (below).

- **Telegram** is DB-gated: a chat is handled iff a `(telegram, chatId)`
  identity exists (`resolveTelegramScope`); unknown chats are dropped, no
  auto-provisioning.
- **HTTP** (`/text`, `/audio`, `/assist`) is DB-gated: allowed iff the Bearer
  token's sha256 hash has an `http` identity (`httpTokenAllowed`);
  unknown/missing → 401. Scope = the resolved identity's `personal` + household.
  `/assist` resolves to whatever token the caller presents.
- **Realtime `/voice`** is DB-gated exactly like HTTP: the WS handshake's
  Bearer token is sha256-hashed and looked up as a `voice` identity
  (`authorizeSpeaker` → `wsServer.ts`); unknown/missing → handshake rejected
  (`4401`). The resolved principal gives the **speaker its own personal memory**
  (e.g. "you are in the living room" → the speaker's personal, biasing its tool
  choices). There is no shared env token and no household fallback — each
  speaker carries its own per-device token (registered via the web panel's
  Users page or `attach-voice`).

**Bootstrap (fresh DB).** A new DB has zero identities, so nobody can
authenticate until you add principals via the CLI:

```
npm run users -- add-user --name me                          # a person
npm run users -- attach-telegram --user <id> --chat <chatId>
npm run users -- mint-http --user <id>                       # prints the token once

npm run users -- add-user --name living-room                 # the speaker
npm run users -- attach-voice --user <id> --token <device-token>
```

`VA_DEVICE_TOKEN`, `HTTP_API_KEYS` and `TELEGRAM_ALLOWED_CHAT_IDS` are **no
longer used at all** — every channel authenticates against DB identities.

**Management CLI:** `npm run users -- <cmd>` (`cli/users.ts`): `add-user`,
`attach-telegram`, `attach-voice`, `mint-http`, `set-admin`. `mint-http` prints
the token once and stores only its hash. The **web panel's Users page** does the
same CRUD (create/rename/admin-toggle users; add/edit/delete devices; mint &
re-mint http tokens — same sha256 hashing as the CLI). Both write the same
`users`/`identities` rows, which auth reads **live** (per request), so edits
take effect immediately — no restart.

### Web config (settings & prompts)

Runtime config is editable from a web panel (`web/`, a separate Nuxt SSR app —
see below). Two DB-backed sources, both **applied on the next process start**,
never hot-reloaded:

- **`settings` table** (`src/settings/sqliteSettings.ts`, `SettingsStore`) — a
  key/value store of **DB-only feature config**, read by dedicated resolvers, NOT
  via env: `http.{text,audio,assist}` → `resolveHttpConfig`, `telegram.enabled` →
  `resolveTelegramEnabled`, `realtime.*` → `resolveRealtimeConfig`, `tools.*`
  (memory/reminders/weather toggles + weather units/location; **on by default**)
  → `resolveToolsConfig`. There is **no env-overlay** — nothing is web-edited
  _into_ `process.env`. Process-level config (`MEMORY_DB_PATH`, **`TZ`**,
  `HTTP_SERVER_PORT`, `REALTIME_PORT`) is plain env via `loadConfig()`; `TZ` is
  **required** (no UTC fallback). **No secrets in env**: OpenAI's api key, HA's
  url/token, and the Telegram bot token live in the `integrations` table;
  realtime device tokens are `voice` identities (hashes) in the `identities`
  table. (See the MCP client and Realtime sections.)
- **`prompts` table** (`src/settings/sqlitePrompts.ts`, `SqlitePrompts`) —
  editable prompt text for **all** prompts, fronted by the prompt registry
  (`src/agent/prompts/registry.ts`). `initPromptRegistry` (called in
  `cli/shared.ts` bootstrap) seeds every bundled `.md` via `seedWithDefault`
  (empty `content`, bundled text in `default_content`) and binds the store;
  consumers read through `resolvePrompt(name)`, which falls back to the bundled
  default when `content` is empty. See the "Prompt text…" subsection above for
  the full layout.

Because these apply only on restart, the panel shows a **config-drift
indicator** next to "Apply changes (restart)". On bootstrap `cli/shared.ts`
stamps `config_loaded_at` (unix ms) into a `runtime_state` table
(`src/settings/sqliteRuntimeState.ts`, `RuntimeStateStore` — process-written
facts, not user config) once it has read settings + prompts + integrations. The
web `GET /api/config-status` compares it against `MAX(updated_at)` over those
three tables (`web/server/utils/db/{runtimeState,configStatus}.ts`): loaded ≥
last edit → up to date, else a restart is pending (`null` = never loaded). The
integrations row's `updated_at` is reused as the edit timestamp — no separate
marker is written on save.

### Scheduled actions

The agent has a single `schedule_action(goal, schedule_kind, schedule_expr)` tool. Two forms:

- **One-shot**: `schedule_kind: 'once'` + a wall-clock string in the server timezone (`"2026-04-27 09:00"`).
- **Recurring**: `schedule_kind: 'cron'` + a POSIX 5-field cron string evaluated in the server timezone (`"0 8 * * *"`).

At fire time the scheduler spawns a fresh `OpenAiAgent.respond()` in **goal mode** (no `ask` tool, fresh `Session`) with the goal as the user message.

Persistence: SQLite table `scheduled_actions`. Cron rows reschedule themselves; once rows transition to `done` (or `error`).

Server timezone: `process.env.TZ` (IANA name, e.g. `Europe/Madrid`). The `[unified] channels: telegram=… http=… realtime=… TZ=… [WEB_SEARCH=on]` startup line confirms what's active.

`Scheduler.tick()` runs every 15 s, processes due rows in series, and is re-entrancy-guarded so a slow goal can't cause overlapping fires.

### Telegram (`src/telegram/`)

**Telegram is a web-panel integration, not env** (`resolveTelegramConfig`,
`src/integrations/telegram.ts`), and runs only when **both** a token is
configured **and** the channel's own toggle is on (`telegram.enabled`, DB-only
setting, `resolveTelegramEnabled`, web panel's Telegram page; default off) —
installing/enabling the integration alone doesn't start the bot. When either is
missing the **telegram runner doesn't start**, and `senderFor` returns a sender
that **throws on send** so a stray goal/`send_to_telegram` fails loudly instead
of dropping silently. `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` env vars are no
longer read.

Bidirectional. **Outbound:** `TelegramSender` interface, `BotTelegramSender`
posts to `https://api.telegram.org/bot<token>/sendMessage` for one chat id.
There is **no fixed default chat** — `shared.ts` exposes a
`senderFor(chatId)` factory, and both the `send_to_telegram` tool and the
goal runner resolve a recipient's chat via DB identities
(`identities.identityFor` / `listTelegramUsers`) before building a sender.

**Inbound:** `TelegramReceiver` interface, `GrammyReceiver` long-polls via
grammY (`bot.start({ drop_pending_updates: false })`; a fatal polling failure
crashes the process so the container restarts). The Bot API client is
**grammY** throughout; file downloads (voice, photos) resolve `file_id` →
direct URL through `fileLink.ts` (`api.getFile` → `https://api.telegram.org/file/bot<token>/<file_path>`).
Voice messages get transcribed via OpenAI; photos are forwarded as multimodal
input.

**Replies stream as drafts.** While the agent generates a reply, the runner
live-streams it via Bot API `sendMessageDraft` (`DraftStreamer` in
`src/telegram/draftStreamer.ts`): an empty placeholder draft goes out
immediately (clients render a localized "Thinking…"; macOS doesn't support
it yet and shows nothing) and is re-sent every 20s while tools run (drafts
expire after ~30s), then accumulated output-text deltas are pushed throttled
to one call per second, and the final regular `sendMessage` persists the
reply. `DRAFT_PLACEHOLDER` can be set to a literal text if the placeholder
should render everywhere. Drafts are
plain text on purpose — partial markdown would break MarkdownV2 mid-stream;
only the final `send()` formats. Draft sends are best-effort: failures are
logged at debug and never break the reply path. `TelegramSender.sendDraft`
is optional — senders without it keep the old send-once behavior.

Each chat has a self-persisting `Session` (SQLite table `telegram_sessions`)
with `idleTimeoutMs: Infinity` — the chain only resets via `/reset` or when
OpenAI evicts the `previous_response_id` (then `OpenAiAgent.respond` catches
the 404 and retries fresh).

Allow-list is **DB-backed** (`identities` table, channel `telegram`, identity =
chatId): a chat is accepted iff `resolveTelegramScope` finds a matching identity;
unknown chats are dropped. Add chats via the `users` CLI (see Memory) —
`TELEGRAM_ALLOWED_CHAT_IDS` is no longer used. Commands: `/start`, `/help`,
`/reset`, `/profile`, `/update`.

### HTTP (`src/cli/runners/http.ts`)

**The server always starts** (so `/health` is always reachable — the container
healthcheck). Each input endpoint is mounted only when its DB-only flag is on
(`resolveHttpConfig`, default off): `http.text` / `http.audio` (HTTP API page),
`http.assist` (HA Assist page). A disabled endpoint isn't registered → 404. Listen
port is `config.http.port` (`HTTP_SERVER_PORT`, default 3000).

h3-based server. Three POST endpoints share auth + rate-limits but split
on agent flavour and response shape:

- `POST /audio` — raw audio bytes (Content-Type derives the format).
  Transcribed via `OpenAiStt` then run through the **plain** agent.
  Returns `{response, transcript}`. Used by Apple Shortcut.
- `POST /text` — `application/x-www-form-urlencoded`, `text` form field.
  Run through the **plain** agent. Returns `{response}`. Minimal
  generic contract — any HTTP client (Apple Shortcut, curl, third-party
  bridges) can hit it.
- `POST /assist` — `application/json`, `{"text": "...",
"conversation_id"?: "..."}`. Run through the **assist** agent:
  voice-addendum system prompt (TTS-friendly output), `ask` tool
  enabled, per-`conversation_id` server-side session. Returns
  `{response, continue_conversation}`. The HA-side
  `http_conversation_agent` integration (in `ha-http-conversation-agent`)
  reads `continue_conversation` and sets it on the `ConversationResult`
  so HA's Assist pipeline reopens the mic without a new wake-word.
  Any non-HA client that wants HA-style sessions can use this endpoint
  too.
- `GET /health` — `{status: "ok"}`.

The plain vs assist split is enforced by two separate `OpenAiAgent`
instances passed into the runner — they differ in `enableAsk` and in
the channel's system prompt (see `buildAgent` / `buildSystemPromptFor`
in [src/cli/shared.ts](src/cli/shared.ts)).

Auth is DB-backed (`checkAuthAndRate` → `httpTokenAllowed`): the
`Authorization: Bearer <key>` token's sha256 hash must have an `http` identity
in the `identities` table, else **401**. Tokens are created with the `users`
CLI (`npm run users -- mint-http`); `HTTP_API_KEYS` is no longer used. Scope follows from the
same lookup: `resolveHttpScope` maps the token hash to its `{ userId }` and the
resulting `ScopedProfile` is passed into the agent so the response reads
`household ∪ personal(user)` and writes personal by default. `/assist` resolves
to whatever token the caller presents — its own principal's scope. Two
rate-limit layers: per-IP for failed auths (10 / 5 min) and
per-token (30 / min). `/audio` also has a concurrency semaphore (2) to bound
Whisper spend on a Pi.

### Realtime bridge (`src/realtime/`)

The Voice PE direct-streaming path. A second server runs alongside the
HTTP runner — **gated by the DB-backed realtime enable switch** (the web
panel's HA Voice Realtime page; read via `resolveRealtimeConfig`, not env) — and exposes
a WebSocket at `:3001/voice`. Devices authenticate per-connection against the
`voice` identities (no shared env token). Each device opens one WS; the bridge
brokers between the device, OpenAI's Realtime API, and the MCP client the agent
core uses.

Key files:

- `src/realtime/wsServer.ts` — HTTP+WS on `REALTIME_PORT` (default
  `3001`). Bearer-token auth by `voice`-identity hash lookup
  (`authorize` → `authorizeSpeaker`), single path `/voice`. Spawns one
  `RealtimeBridge` per accepted connection, scoped to the resolved speaker.
- `src/realtime/realtimeBridge.ts` — per-session orchestrator: device
  WS ↔ OpenAI Realtime ↔ HA MCP. Owns the phase state machine
  (`idle` / `listening` / `thinking` / `replying`), audio passthrough
  (with resampling), tool-call dispatch, transcript logging, and
  shutdown. Cancels empty-transcript turns before they hit the model
  (the `empty-transcript-cancel` guard) to avoid spurious responses
  on silence.
- `src/realtime/openaiRealtimeClient.ts` — thin wrapper around the
  OpenAI Realtime WebSocket. Builds the `session.update` payload from
  config (model, voice, modalities, tools, system prompt, input audio
  transcription via `whisper-1`), forwards audio/text/tool events
  upstream, surfaces typed events downstream.
- `src/realtime/audio/format.ts`, `src/realtime/audio/resample.ts` —
  PCM16 helpers and 16↔24 kHz linear resampling. Device sends mono
  16 kHz PCM16; Realtime expects 24 kHz.
- `src/realtime/toolAdapter.ts` — converts the MCP tool list (from
  `HaMcpClient`) into the Realtime API's `tools` schema.
- `src/realtime/protocol.ts` — JSON wire protocol with the device:
  server→device `hello` (handshake ack; carries `audioOut` + `wakeChime`,
  the admin's wake-beep preference the device gates its local wake sound
  on), `phase`, `error`, `pong`, `follow_up`; device→server `start`,
  `interrupt`, `ping`. Binary frames are raw PCM16 in both directions. `follow_up {ms, chime?}` is sent right before
  the end-of-turn `idle`, but only after a **spoken** reply: the device
  latches it and reopens the mic once the reply drains. Two flavours: the
  ambient after-every-reply window (`ms` = `realtime.followUpMs`, silent)
  and the explicit-question window (`ms` = `realtime.requestFollowUpMs`,
  `chime:true` gated by `realtime.followUpChime`) — the latter fires
  whenever the model calls the `request_follow_up` **tool** and is
  independent of the ambient toggle (a question is answerable even with
  ambient off). A silent `wait_for_user`, a barge-in interrupt, a
  silent/tool-only response, or the initial idle send **no** `follow_up`,
  so the mic stays closed. The server owns this decision; the device
  never decides on its own. (`request_follow_up` is a model tool, not a
  wire message — it maps to `follow_up {chime}`.)
- `src/realtime/metrics.ts` — `LatencyTracker` for the
  `bridge_start → openai_connected → first_audio_in → first_audio_out`
  markers. Logged on session end.

Important behaviour:

- **Tool calls go through the same `HaMcpClient`** that the
  Responses-API agent uses — there's only one HA MCP client per
  process.
- **System prompt is shared with the assist channel**: built via
  `buildSystemPromptFor('assist')` so the voice-flavour rules
  (TTS-friendly output, brevity, no markdown) apply to the Realtime
  session too.
- **Logs mirror the agent core**: the bridge emits `user → <transcript>`,
  `assistant → <transcript>`, and per-tool `name(args) → result (Nms)`
  lines so transcripts look uniform across channels.
- **Input audio transcription** uses `whisper-1` inside the Realtime
  session (separate from the Realtime model's own internal STT) so
  user transcripts are available for logging / memory.

Config sources:

| Setting                                                                   | Source                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| enable + idle reset + output pacing + follow-up windows + follow-up chime | **DB-only realtime config** (`resolveRealtimeConfig`, `src/settings/realtimeConfig.ts`) — read from the `settings` table under `realtime.*` keys via the web panel's HA Voice Realtime page (`/api/realtime`). NOT env. `realtime.followUpMs` (default 8000, 0 disables) = ambient window after any spoken reply; `realtime.requestFollowUpMs` (default 10000, 0 disables) = the explicit-question window, **independent** of followUpMs (a `request_follow_up` question reopens the mic even when ambient is off); `realtime.followUpChime` (default off) plays a chime on the question window (all three ride the `follow_up` event sent before the end-of-reply idle); `realtime.wakeChime` (default on) is the device's local wake-word beep, pushed once in the `hello` handshake (the device has no HA/web control surface for it). |
| model / voice / effort                                                    | **OpenAI integration** (`realtimeModel`, `realtimeVoice`, `realtimeReasoningEffort`) — provider-specific.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| device token                                                              | **`voice` identity** in the `identities` table (sha256 of the per-device token). The WS hash-looks-up the presented Bearer; unknown → `4401`. Registered via the Users page / `attach-voice`. No env token.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `REALTIME_PORT`                                                           | env, default `3001`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

### MCP client (`src/mcp/haMcpClient.ts`)

Wraps `@modelcontextprotocol/sdk` Streamable HTTP transport with Bearer auth against HA's `/api/mcp`. Single replaceable adapter — the `McpClient` interface is the contract used by everything else.

**Home Assistant is configured via the web panel, not env.** `HA_URL`/`HA_TOKEN`
are gone. At startup `cli/shared.ts` reads the `home-assistant` row from the
`integrations` table (`resolveHaConfig`, `src/integrations/`). HA is active iff
the row is **present, `enabled`, and has url+token** → `HaMcpClient`; otherwise
→ `NullMcpClient` (`src/mcp/nullMcpClient.ts`), which exposes **zero tools**, so
the agent runs fine without HA — no HA MCP tools on any channel, and
`haEnabled=false` drops the `ha-addendum` from the system prompt. The
`integrations` table has an `enabled` flag (disable keeps the config but
deactivates). Install/edit/enable in the panel's Integrations (dry-runs a
connection test before saving or enabling); disabling is instant. Each
integration **owns** prompts (HA: `ha-addendum` + `ha-suffix/*`, declared in
`web/server/utils/integrations.ts`); the Prompts page hides a disabled/absent
integration's prompts (rows are kept, just filtered). The `mcp:call` CLI reads
the same row and errors if HA isn't installed/enabled.

**OpenAI is also a web-panel integration, not env** (`resolveOpenAiConfig`,
`src/integrations/openai.ts`). It's **mandatory** — `cli/shared.ts` throws at
startup if the `openai` row is absent/disabled/keyless. It supplies the api key,
optional base URL, chat model + reasoning effort, `web_search` toggle, and the
realtime model/voice/effort (provider-specific). The realtime _enable_ switch +
pacing/idle are **not** here — they're DB-only realtime config (`resolveRealtimeConfig`,
HA Voice Realtime page).
`OPENAI_*` env vars are no longer read. Only `model`/`reasoningEffort`/`voice`
etc. have code defaults applied when blank; the api key is required.

The `/update` command writes the string `trigger\n` to `/tmp/va-update`
(expected to be a host-mounted FIFO; falls back to a no-op if the path
isn't writable). Whoever deploys this container is responsible for
creating the FIFO and running something that reads it and performs the
actual update — this codebase only signals intent. Changing the path
or write semantics is a breaking change for every deployment.

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
