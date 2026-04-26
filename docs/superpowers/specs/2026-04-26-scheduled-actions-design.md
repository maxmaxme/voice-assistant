# Scheduled Actions — Design

## Problem

Users want recurring goals expressed in natural language:

- "каждый день в 8 утра присылай мне погоду в Мадриде"
- "каждый понедельник в 7:30 включай свет на кухне"
- "через час напомни позвонить маме" (one-shot, today's `add_reminder`)
- "включи свет и напиши мне в телеграм" (compound action)

Current state: we have `add_reminder` (one-shot Telegram message) and `set_timer` (one-shot countdown Telegram). Neither supports recurrence; neither can perform device actions; neither composes.

Two delivery models exist for recurring tasks:

1. **Frozen plan**: store the exact tool calls at creation time. Cheap, deterministic. Brittle: a snapshot of "включи свет на кухне" stays bound to the lamps that existed at scheduling time. Adding a new lamp does not propagate.
2. **Stored intent + re-plan**: store natural-language goal. Run a mini-agent at fire time. Adapts to current Home Assistant state, supports compound actions (HA tool + Telegram + memory + future tools), zero special-casing.

We choose **stored intent + re-plan**. Cost is ~$0.0003 per fire on `gpt-4o-mini` (~1.5k input + 150 output tokens). A daily cron runs ~$0.10/year. Adaptivity is worth it.

## Goals

- Single `schedule_action(goal, schedule)` tool replaces `add_reminder` + `set_timer`.
- `schedule` accepts one of:
  - `{ kind: 'once', at: number }` — Unix ms UTC
  - `{ kind: 'cron', expr: string }` — POSIX cron, evaluated in `process.env.TZ`
- At fire time the scheduler runs the agent on the goal in a fresh, single-turn `Session` (no history). Tools available: full set the agent normally has — HA MCP, memory, send_to_telegram, optionally web_search.
- Once-actions auto-cancel after firing. Cron actions reschedule themselves.
- Idempotency on process restart: a fire that was in flight when the process died is repeated at most once on next tick (we accept duplicates over silent loss).
- Old `reminders`/`timers` rows migrate forward as `kind: 'once'` actions; old SQL tables are kept for one release in case we need to roll back, then dropped.

## Non-goals (this iteration)

- RRULE (RFC 5545) — cron covers ~95% of asks; defer.
- Sun-relative triggers (sunrise/sunset) — defer to HA automations or a follow-up.
- Cross-restart "fire missed schedules" replay — when the Pi was off all night, we do **not** retroactively run the 8am cron at 9am. Once `next_fire_at` is in the past at boot, we advance it to the next future occurrence and skip the missed one.
- Per-user/multi-user scheduling — single user.
- A UI. Listing/cancelling is via the chat/voice agent.

## Architecture

```
src/scheduling/
├── scheduler.ts              # MODIFIED: ticks scheduled_actions instead of reminders+timers
├── cron.ts                   # NEW: nextFireAt(schedule, now, tz) using cron-parser
├── goalRunner.ts             # NEW: spawns a single-turn agent run for a goal
└── types.ts                  # MODIFIED: Schedule union, ScheduledAction, FireGoalSink

src/memory/
├── types.ts                  # MODIFIED: + ScheduledAction, ScheduledActionsAdapter
├── migrations.ts             # MODIFIED: + v4
├── sqliteScheduledActions.ts # NEW
└── memoryStore.ts            # MODIFIED: + scheduledActions

src/agent/
├── scheduledActionTools.ts   # NEW: schedule_action / list_scheduled / cancel_scheduled
├── reminderTools.ts          # DELETED
├── timerTools.ts             # DELETED
└── openaiAgent.ts            # MODIFIED: register new tools, drop old ones; add executeGoal()

src/cli/
├── unified.ts                # MODIFIED: scheduler wiring uses goalRunner instead of FireSink
└── shared.ts                 # MODIFIED: drop FireSink, build a goalRunner for the scheduler
```

## Schema (migration v4)

```sql
CREATE TABLE scheduled_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  goal TEXT NOT NULL,
  schedule_kind TEXT NOT NULL CHECK (schedule_kind IN ('once', 'cron')),
  schedule_expr TEXT NOT NULL,           -- "1777222737000" or "0 8 * * *"
  status TEXT NOT NULL DEFAULT 'active', -- active | done | cancelled | error
  next_fire_at INTEGER NOT NULL,
  last_fired_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_scheduled_actions_due
  ON scheduled_actions(next_fire_at)
  WHERE status = 'active';

-- Migrate forward existing one-shot rows.
INSERT INTO scheduled_actions (goal, schedule_kind, schedule_expr, status, next_fire_at, last_fired_at, created_at)
SELECT
  'Напиши мне в Telegram: ' || text,
  'once',
  CAST(fire_at AS TEXT),
  CASE status WHEN 'pending' THEN 'active' WHEN 'fired' THEN 'done' ELSE status END,
  fire_at,
  fired_at,
  created_at
FROM reminders;

INSERT INTO scheduled_actions (goal, schedule_kind, schedule_expr, status, next_fire_at, last_fired_at, created_at)
SELECT
  'Напиши мне в Telegram: ⏱ Timer "' || label || '" finished.',
  'once',
  CAST(fire_at AS TEXT),
  CASE status WHEN 'active' THEN 'active' WHEN 'fired' THEN 'done' ELSE status END,
  fire_at,
  fired_at,
  created_at
FROM timers;

-- Old tables stay for one release (drop in a later migration).
```

## Tool API for the LLM

```ts
schedule_action({
  goal: string,                       // natural language; what to do at fire time
  schedule_kind: 'once' | 'cron',
  schedule_expr: string,              // 'YYYY-MM-DD HH:mm[:ss]' for once (server TZ),
                                      // POSIX cron for recurring (evaluated in server TZ)
})
→ { id, goal, schedule_kind, schedule_expr, next_fire_at, next_fire_at_local }

list_scheduled() → Array<{
  id, goal, schedule_kind, schedule_expr,
  next_fire_at, next_fire_at_local,
  last_fired_at, last_fired_at_local | null
}>

cancel_scheduled({ id }) → { ok: boolean }
```

The system prompt steers the LLM: prefer `cron` for words like "каждый/every/каждое утро", `once` with `at_local` (we re-use the wall-clock string format already established in `parseLocalWallClock`) for absolute moments, no `fire_at` Unix-ms input — we lost nothing by dropping it.

For schedule-kind=`once` the `schedule_expr` is a wall-clock string parsed via `parseLocalWallClock`. No more bare epoch ms in the public tool surface — that's where the LLM kept slipping on timezones.

## Fire-time execution

`Scheduler.tick()` (every 15 s):

1. `actions.listDue(now)` → rows where `status='active'` and `next_fire_at <= now`.
2. For each row, in series (parallel-safe but cheap):
   a. Compute the next fire **before** running the goal (so a crash mid-run still advances the schedule):
   - `once` → set `status='done'`, `next_fire_at` left as-is for the audit trail.
   - `cron` → `next_fire_at = nextFireAt(schedule, now)`.
     `last_fired_at = now`.
     b. `goalRunner.fire(goal)` — runs a single-turn `OpenAiAgent` invocation:
   - Fresh `Session` (no `previous_response_id`).
   - System message = base system prompt + a one-line directive: `Execute this scheduled goal now: "<goal>". When done, summarise what you did in one sentence.`
   - User message = empty string (some Responses-API dance — likely a literal `"."` to avoid empty-input rejection).
   - The agent gets the same tool set as a normal turn (HA MCP, memory, telegram, optionally web_search).
   - Final text reply is logged but not delivered. If the goal wanted to talk to the user it called `send_to_telegram` itself.
     c. On `goalRunner.fire` throwing, log the error, leave the row's status alone if cron (we already advanced `next_fire_at`, so it'll try again next cycle), else mark `status='error'` for `once`.

The "advance next_fire_at before run" choice is deliberate: at-most-once-per-tick on a misbehaving goal, never tight-looping.

## Optional: web_search tool

To make goals like "погоду на сегодня в Мадриде" work without a HA weather integration, expose OpenAI's built-in `web_search` tool when `OPENAI_WEB_SEARCH=1`. This is ~10 lines in `openaiAgent.ts`: append `{ type: 'web_search' }` to the tools list. No additional schema work — it's a hosted tool.

Off by default (it's not free and adds latency to every turn).

## Risks and mitigations

| Risk                                                                         | Mitigation                                                                                                                          |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| LLM produces an invalid cron string                                          | Validate with `cron-parser` in the tool handler; reject with a clear message including the canonical 5-field format.                |
| LLM produces a `once` time in the past                                       | Reject with the same "in the past" error we already have.                                                                           |
| Goal runner exhausts tool iterations (e.g. infinite ask loop)                | The `OpenAiAgent` already caps iterations; goal-mode reuses that. We may also disable the `ask` tool in goal-mode (no user to ask). |
| DST transition on a `0 2 * * *` cron in a TZ that springs forward over 02:00 | `cron-parser` handles this correctly per its docs; verify with a unit test that pins TZ + DST date.                                 |
| Compound goals run partial actions then fail                                 | We don't transactionalize across HA + Telegram. Document: "scheduled goals are best-effort; on partial failure, no rollback."       |
| User adds a new lamp; "включи свет на кухне" picks it up next morning        | Working as intended. If user wants a frozen list, they say so explicitly in the goal.                                               |
| Duplicate fire on process restart that crashed mid-fire                      | Acceptable. Worst case: a Telegram message twice. We do not add a fire-lock for v1.                                                 |

## Migration of existing rows

Live DB at the time of writing has two `reminders` rows (one in the past, one future). The migration above carries them forward. After verifying behaviour, the `reminders` and `timers` tables stay in place for a release as a safety net; a future migration drops them.

## Backward compatibility

None. The `add_reminder` / `set_timer` tools disappear. The agent is told via system prompt that it should use `schedule_action` for everything time-based. Old conversations referencing "reminders" still work in plain English; the LLM just calls the new tool.

This is an internal-personal-assistant project; no external API to keep stable.

## Open questions (deferred, not blocking)

- Should the goal-runner have a stricter system prompt that forbids `ask`? Probably yes — there's no user. We'll add `ask` to the goal-mode block list when we wire `executeGoal`.
- Should fired goal output go anywhere if the goal does NOT call `send_to_telegram`? For now: log to stderr only. If it bites, we'll add a `[scheduled] {goal} → {summary}` Telegram message.
- Pause/resume? Out of scope; user can `cancel_scheduled` and recreate.
