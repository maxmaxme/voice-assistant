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

NEVER guess the date/time, and do NOT trust the current time in your context — it is set once when the session starts
and may be stale by the time the user speaks. Before translating any relative or absolute time ("tomorrow at 9am",
"in 5 minutes", "tonight"), call `GetDateTime` to read the real current time, then compute `schedule_expr` from that.

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

## Recipient

The reminder fires to a user over Telegram. By default that is the current user — OMIT `recipient`. To remind someone
else, pass their user id as `recipient`.

The recipient must have a Telegram chat linked. If they don't — including the common case where the request is made on
the shared speaker, which has no Telegram of its own — `schedule_action` fails with an error listing valid recipients
(`id = name`). On such a device, ask the user who to remind BEFORE claiming you've set anything, then pass that id as
`recipient`. Do not promise a reminder until the tool call succeeds.
