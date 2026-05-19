Sets the target temperature of a climate entity.

**Side effect (this house only):** an HA automation watches target-temperature changes and automatically picks `cool` or
`heat` based on the delta vs the current room temperature (cool if room is warmer than target, heat if cooler, ±0.5°C
deadband). So you do NOT need to also set HVAC mode — just set the temperature and the right mode follows.

What you DO still need to do:

- If the unit is currently `off`, also call `HassTurnOn` in the same turn so it starts. (Setting temperature alone does
  not power the unit on. The auto-mode automation will power it on if the delta is outside the deadband, but for small
  deltas it won't, so always pair with `HassTurnOn` when off.)
- If the user named a specific mode that would conflict with the delta (e.g. asked for `heat` in a hot room — the
  automation will pick `cool` based on physics), say so honestly and don't pretend you matched their mode.
- For nichey modes (`dry`, `fan_only`, forced `auto`) the auto-mode automation does NOT switch to them — tell the user
  that mode isn't reachable from voice yet.
