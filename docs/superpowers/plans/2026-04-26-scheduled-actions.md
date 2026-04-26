# Scheduled Actions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `add_reminder` + `set_timer` with a single `schedule_action(goal, schedule)` that supports both one-shot (`{kind:'once'}`) and recurring (`{kind:'cron'}`) execution. At fire time, run the agent on the natural-language goal in a fresh Session — adapts to current HA state, supports compound actions ("включи свет и напиши в телеграм"), no schema work for new tools.

**Spec:** `docs/superpowers/specs/2026-04-26-scheduled-actions-design.md`.

**Tech stack:** Node 24 native TS stripping, `better-sqlite3` (existing), `cron-parser` (NEW dep — battle-tested cron evaluator with TZ + DST handling), Vitest + `vi.useFakeTimers()`.

**Prerequisites:** None additional — `2026-04-26-reminders-timers.md` shipped, `MemoryStore` facade and `Scheduler` already in place.

---

## File structure

```
src/memory/
├── types.ts                      # MODIFIED: + ScheduledAction, ScheduledActionsAdapter
├── migrations.ts                 # MODIFIED: + v4 (table + back-fill from reminders/timers)
├── sqliteScheduledActions.ts     # NEW
└── memoryStore.ts                # MODIFIED: + scheduledActions

src/scheduling/
├── cron.ts                       # NEW: nextFireAt(schedule, now) wrapping cron-parser
├── goalRunner.ts                 # NEW: spawn a single-turn agent run for a goal
├── scheduler.ts                  # MODIFIED: tick scheduled_actions instead of reminders+timers
└── types.ts                      # MODIFIED: Schedule union, GoalRunner interface

src/agent/
├── scheduledActionTools.ts       # NEW: schedule_action / list_scheduled / cancel_scheduled
├── reminderTools.ts              # DELETED
├── timerTools.ts                 # DELETED
└── openaiAgent.ts                # MODIFIED: register new tools; add executeGoal(); optional web_search

src/cli/
├── unified.ts                    # MODIFIED: scheduler now takes a goalRunner, not a FireSink
└── shared.ts                     # MODIFIED: drop FireSink builder; build goalRunner from agent
```

---

## Tasks

### Task 1 — Schedule type + cron utility

- [ ] Add `Schedule` union to `src/scheduling/types.ts`:
      `type Schedule = { kind: 'once'; at: number } | { kind: 'cron'; expr: string }`.
- [ ] Add `npm install cron-parser` (production dep) and pin a major.
- [ ] `src/scheduling/cron.ts`: - `nextFireAt(schedule: Schedule, now: number): number` - `once`: returns `schedule.at`. - `cron`: `parseExpression(expr, { tz: getServerTimezone(), currentDate: new Date(now) }).next().getTime()`. - `validateSchedule(s: Schedule): void` — throws on invalid cron expression with a friendly message.
- [ ] `tests/scheduling/cron.test.ts` covering: - Daily 8am cron under `Europe/Madrid` advances day-by-day. - DST-spring-forward day (`0 2 * * *` on America/New_York 2030-03-10) — verify `cron-parser` skips/advances correctly. - Invalid cron throws with a useful error. - `once` returns its `at` verbatim.

**Definition of done:** all utility tests pass, no other code uses cron yet.

### Task 2 — DB migration v4 + adapter

- [ ] Append v4 migration to `src/memory/migrations.ts` (table + index + back-fill from `reminders` and `timers`, see spec for exact SQL).
- [ ] `src/memory/types.ts`:
      `ts
    export interface ScheduledAction {
      id: number;
      goal: string;
      schedule: Schedule;
      status: 'active' | 'done' | 'cancelled' | 'error';
      nextFireAt: number;
      lastFiredAt: number | null;
      createdAt: number;
    }
    export interface NewScheduledAction {
      goal: string;
      schedule: Schedule;
      nextFireAt: number;
    }
    export interface ScheduledActionsAdapter {
      add(input: NewScheduledAction): ScheduledAction;
      listActive(): ScheduledAction[];
      listDue(now: number): ScheduledAction[];
      markFired(id: number, at: number, nextFireAt: number | null): void;
      markError(id: number): void;
      cancel(id: number): boolean;
      get(id: number): ScheduledAction | null;
    }
    `
- [ ] `src/memory/sqliteScheduledActions.ts` — straightforward translation of the adapter against `scheduled_actions`. `markFired(id, at, nextFireAt)`: if `nextFireAt === null` set `status='done'`, else update `next_fire_at` and `last_fired_at`.
- [ ] `src/memory/memoryStore.ts` adds `scheduledActions: SqliteScheduledActions`.
- [ ] `tests/memory/sqliteScheduledActions.test.ts`: - Add → listActive returns it. - Migration v4 carries forward existing reminders/timers rows (use a v3 fixture DB). - listDue filters by `next_fire_at <= now AND status='active'`. - markFired with `null` advances to `done`; with a number updates next_fire_at. - cancel idempotent; returns false on missing.

**Definition of done:** all adapter tests pass; migration v4 applies cleanly on a fresh DB and on a v3 DB with sample reminder/timer rows.

### Task 3 — Tool surface (schedule_action, list_scheduled, cancel_scheduled)

- [ ] `src/agent/scheduledActionTools.ts`: - `SCHEDULED_ACTION_TOOL_NAMES = new Set([...])` - `buildScheduledActionTools()` returning OpenAI function tool defs. Schema for `schedule_action`:
      `       properties: {
        goal: string,
        schedule_kind: enum 'once' | 'cron',
        schedule_expr: string  // wall-clock 'YYYY-MM-DD HH:mm[:ss]' for once, POSIX cron for cron
      }
      required: all four
      ` - `executeScheduledActionTool(adapter, name, args)` with overloads (mirror reminderTools' pattern). - For `once`: parse `schedule_expr` via `parseLocalWallClock`. Reject if past. - For `cron`: validate via `validateSchedule`. Compute first `nextFireAt`. - Return shape includes `next_fire_at` + `next_fire_at_local`.
- [ ] `tests/agent/scheduledActionTools.test.ts` covering: - Once-form happy path; rejects past times; rejects malformed at_local. - Cron-form happy path; rejects invalid expr; nextFireAt is in the future. - list_scheduled returns active only with both \_local fields. - cancel_scheduled returns ok:true / ok:false.

**Definition of done:** tool tests pass, schema strict-mode-friendly (no optional fields outside `["X","null"]` pattern if any are needed).

### Task 4 — Goal runner

- [ ] `src/scheduling/goalRunner.ts`:
      `ts
    export interface GoalRunner { fire(goal: string): Promise<void>; }
    export function buildGoalRunner(agentForGoals: Agent): GoalRunner { ... }
    `
      Calls `agentForGoals.respond(systemDirective)` where the directive packages the goal into a self-contained instruction. Uses a separate `Session` instance per fire (no chain, no history).
- [ ] In `OpenAiAgent`: add a constructor option `mode?: 'chat' | 'goal'` (default `'chat'`). In `'goal'` mode: - The base system prompt is replaced/augmented with a one-shot directive: "You are running a previously-scheduled goal. Execute it using your tools. Do NOT call `ask` (no user is present). When finished, return a single-sentence summary as your final reply." - The `ask` tool is omitted from the tool list. - `maxToolIterations` may be tuned (default 5 is fine).
- [ ] `tests/scheduling/goalRunner.test.ts` with a fake `Agent` verifies `fire` calls `respond`. Integration is left to scheduler tests.

**Definition of done:** goal runner unit tests pass; OpenAiAgent goal-mode unit-tested with a stubbed LLM that emits a `send_to_telegram` tool call.

### Task 5 — Scheduler refactor

- [ ] `src/scheduling/scheduler.ts`: replace the two `reminders` + `timers` paths with one `scheduledActions` path: - On tick: `listDue(now)` → for each row, compute `next` via `nextFireAt(schedule, now)` if cron else `null` (signals once → done). - Update DB **before** firing the goal (advance/done) so a crash doesn't tight-loop. - Call `goalRunner.fire(goal)`. On throw, log and `markError` for once-actions; cron rows stay active (already advanced).
- [ ] Drop `FireSink` and the corresponding wiring in `src/cli/shared.ts`. The new dep is a `GoalRunner`.
- [ ] `tests/scheduling/scheduler.test.ts` rewritten: - Due once-action fires and is marked done. - Due cron action fires and `next_fire_at` advances by ~24h for `0 8 * * *`. - Goal runner throwing on a cron row leaves status active (already advanced). - Goal runner throwing on a once row marks status='error'. - Multiple due rows in one tick: all fire, in order.

**Definition of done:** scheduler tests green; integration-level test that constructs a real `OpenAiAgent` with a stubbed LLM and verifies a `send_to_telegram` call lands.

### Task 6 — Wire into unified.ts; remove old tools

- [ ] `src/cli/shared.ts` — build a per-process `goalAgent` (separate channel/agent instance with `mode: 'goal'`) and a `GoalRunner` over it. Drop `fireSink`.
- [ ] `src/cli/unified.ts` — `Scheduler` constructor receives `{ scheduledActions, goalRunner }`.
- [ ] `src/agent/openaiAgent.ts` — drop imports of `reminderTools`, `timerTools`; add `scheduledActionTools`. Update tool list.
- [ ] Delete `src/agent/reminderTools.ts`, `src/agent/timerTools.ts`, and their tests.
- [ ] Update `tests/cli/unified.test.ts` mocks (no more `fireSink`, `memory` shape changed).

**Definition of done:** `npm test && npm run typecheck && npm run lint` all green; running `npm run chat` lets you say "каждый день в 8 утра пиши мне погоду в Мадриде" and observe a `schedule_action` tool call in stderr.

### Task 7 — Optional web_search tool

- [ ] In `openaiAgent.ts`, when `process.env.OPENAI_WEB_SEARCH === '1'`, append `{ type: 'web_search' }` to the tools array.
- [ ] Document in `.env.example`. Default off.
- [ ] No tests required (it's a passthrough flag).

**Definition of done:** `OPENAI_WEB_SEARCH=1 npm run chat`, ask "какая сейчас погода в Мадриде", agent replies with current weather.

### Task 8 — System-prompt + docs

- [ ] In `src/agent/openaiAgent.ts::buildSystemMessage`, replace the reminder/timer guidance with scheduled-action guidance: - "For one-shot scheduling, use `schedule_action` with `schedule_kind: 'once'` and `schedule_expr` as a wall-clock string in the server timezone." - "For recurring schedules, use `schedule_kind: 'cron'` and a 5-field POSIX cron string evaluated in the server timezone." - Examples: `0 8 * * *` (daily 08:00), `30 7 * * 1-5` (weekdays 07:30), `*/15 * * * *` (every 15 min).
- [ ] `CLAUDE.md` — replace the "Reminders & timers — server timezone" block with a "Scheduled actions" block. Note: `add_reminder` / `set_timer` are gone, `schedule_action` covers both. Mention `OPENAI_WEB_SEARCH` if Task 7 done.
- [ ] `README.md` — short mention in the features section.

**Definition of done:** docs match the new behaviour; running the chat REPL with no other context produces correct cron strings for representative requests.

---

## Risks / open issues during implementation

- **`cron-parser` major bump**: pin to the version current at start. Re-evaluate on next dep update.
- **Old reminder/timer tests**: deleted, not migrated. They covered behaviour now replaced by scheduledActionTools tests.
- **`ask` tool in goal mode**: omitting it changes the agent's tool list mid-process when scheduler triggers. Make sure goal-mode is its own `OpenAiAgent` instance, not a flag on a shared one — clean separation.
- **Duplicate fires on restart**: spec accepts this. Don't add a lock without evidence it's needed.

## Out of scope (rolled to roadmap)

- Sun-relative triggers (sunrise/sunset).
- RRULE / iCalendar.
- Cross-restart "fire missed schedules" replay.
- Per-user multi-user.
- A web/Telegram UI for managing scheduled actions outside chat.
