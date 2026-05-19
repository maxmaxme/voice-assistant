Schedule a future natural-language goal for the assistant to carry out at a later time. REPLACES `add_reminder` and
`set_timer` — use this for any future-time goal, one-shot or recurring.

At fire time, `goal` is replayed to the assistant verbatim, so write it as a clear, self-contained instruction (include
any context the assistant will need, e.g. "turn on the kitchen light and send me a good morning message in Telegram").

## Formats

- **One-shot** — `schedule_kind: "once"`, `schedule_expr` is a wall-clock string in the SERVER timezone:
  `"YYYY-MM-DD HH:mm"` or `"YYYY-MM-DD HH:mm:ss"` (NO timezone offset). Must be in the future.
- **Recurring** — `schedule_kind: "cron"`, `schedule_expr` is a POSIX 5-field cron expression evaluated in the server
  timezone. Examples: `"0 8 * * *"` (daily 08:00), `"30 7 * * 1-5"` (weekdays 07:30), `"*/15 * * * *"` (every 15
  minutes).

NEVER guess the date/time. If the user says "tomorrow at 9am" / "in 5 minutes", translate to the actual calendar date
based on the current time the system tells you.

## HARD RULE — reminders MUST go through Telegram

When the user says "напомни" / "remind me" / "wake me" / "tell me later" — anything where the only outcome is that the
user hears about something later — the `goal` MUST instruct the fire-time agent to call `send_to_telegram` with the
reminder text. At fire time there is NO USER PRESENT, so a bare goal like "забронировать бассейн" or "buy milk" produces
text nobody sees.

- ❌ WRONG: `goal: "забронировать бассейн"`
- ✅ RIGHT: `goal: "отправь в Telegram напоминание: забронировать бассейн"`
- ❌ WRONG: `goal: "remind to take medicine"`
- ✅ RIGHT: `goal: "send a Telegram message reminding to take medicine"`

Skip the Telegram wrapper ONLY when the goal is itself a concrete tool action ("turn on the kitchen light at 08:00", "
set thermostat to 22 at 22:00") the fire-time agent can carry out via Home Assistant without needing to notify the user.
