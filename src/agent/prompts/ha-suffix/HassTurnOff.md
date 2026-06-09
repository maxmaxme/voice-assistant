**Air conditioners / climate devices: do NOT use this tool.** If a unified
AC-control tool (e.g. `ac_control`) is in your tool list, turn an AC off with
`mode=off` through it instead.

**Duplicate names:** several rooms may have devices sharing a name or alias
(e.g. two units both nicknamed "AC"). A bare `name` matching two entities fails
with `MatchFailedError: DUPLICATE_NAME` — always pass `area` together with
`name` when you know the room (from the user's words, your own location in the
profile, or recent conversation).
