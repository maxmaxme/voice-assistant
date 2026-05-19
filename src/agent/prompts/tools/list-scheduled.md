List active scheduled actions, sorted by `next_fire_at` ascending.

Includes both one-shot (`schedule_kind: "once"`) and recurring (`"cron"`) entries. Each row has `id`, `goal`,
`schedule_kind`, `schedule_expr`, `next_fire_at_local`, and `last_fired_at_local`.

Call this when the user asks "что у меня запланировано?" / "what's scheduled?" / "show my reminders", or as a
prerequisite to `cancel_scheduled` so you can identify the correct `id`.
