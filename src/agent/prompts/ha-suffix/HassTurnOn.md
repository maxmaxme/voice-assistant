**Air conditioners / climate devices: do NOT use this tool.** Turning an AC
"on" this way resumes whatever mode it last had — rarely what the user meant.
If a unified AC-control tool (e.g. `ac_control`) is in your tool list, use it
with an explicit `mode` (`cool`, `heat`, `fan_only`, `dry`, …) instead.

**Duplicate names:** several rooms may have devices sharing a name or alias
(e.g. two units both nicknamed "AC"). A bare `name` matching two entities fails
with `MatchFailedError: DUPLICATE_NAME` — always pass `area` together with
`name` when you know the room (from the user's words, your own location in the
profile, or recent conversation).
