Schedule a future natural-language goal for the assistant to carry out at a later time. REPLACES `add_reminder` and
`set_timer` — use this for any future-time goal, one-shot or recurring.

At fire time, `goal` is replayed to the assistant verbatim, so write it as a clear, self-contained instruction that can
stand alone — there is NO USER PRESENT at fire time and no way to ask follow-up questions. Include any context the
fire-time assistant will need (e.g. "turn on the kitchen light at 08:00").

## Formats

- **One-shot** — `schedule_kind: "once"`, `schedule_expr` is a wall-clock string in the SERVER timezone:
  `"YYYY-MM-DD HH:mm"` or `"YYYY-MM-DD HH:mm:ss"` (NO timezone offset). Must be in the future.
- **Recurring** — `schedule_kind: "cron"`, `schedule_expr` is a POSIX 5-field cron expression evaluated in the server
  timezone. Examples: `"0 8 * * *"` (daily 08:00), `"30 7 * * 1-5"` (weekdays 07:30), `"*/15 * * * *"` (every 15
  minutes).

NEVER guess the date/time. If the user says "tomorrow at 9am" / "in 5 minutes", translate to the actual calendar date
based on the current time the system tells you.

## Delivery at fire time — write `goal` as the content, NOT "send to Telegram"

Whatever the fire-time assistant replies is **automatically delivered to the person who scheduled it** over Telegram.
There is no "send" tool at fire time — do NOT wrap the goal in one, and do NOT mention Telegram in the goal.

- For a plain reminder ("remind me …" / "tell me later" — the only outcome is the user hearing about something), write
  `goal` as the reminder content itself, in the user's own language. The fire-time assistant restates it and the user
  receives it.
  - ✅ RIGHT: `goal: "walk the dog"`
  - ✅ RIGHT: `goal: "book the pool"`
  - ❌ WRONG: `goal: "send a Telegram reminder: walk the dog"` (no send tool exists at fire time)
  - ❌ WRONG: `goal: "send a Telegram message reminding to take medicine"`
- For an action the fire-time assistant should perform (via Home Assistant etc.), write the action; its short
  confirmation is what gets delivered.
  - ✅ RIGHT: `goal: "turn on the kitchen light"`
  - ✅ RIGHT: `goal: "set the thermostat to 22"`

Scheduling requires the scheduling user to have a Telegram chat to deliver to. If they don't (e.g. a request made on the
speaker), `schedule_action` fails with a clear error — relay it to the user (in their language); do not retry.
