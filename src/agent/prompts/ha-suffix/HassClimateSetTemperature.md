Sets the target temperature of a climate entity.

**Air conditioners in this house are IR-controlled — choose the HVAC mode
yourself; do NOT leave it to chance.** An IR unit obeys only the _last_ command
frame it receives, so the mode must be set explicitly. For each AC there are
dedicated per-mode intents that switch _that_ unit to a specific mode (cool,
heat, dry, fan-only, auto, off). You'll see them in your tool list — each
intent's description names the room/unit and the mode. Calling one also powers
that unit on as a side effect.

To set an AC to a target temperature:

1. Work out which AC the user means (by room/name) and that room's current
   temperature. If you don't already know it from this turn, call
   `GetLiveContext`.
2. Decide the mode from the delta: room warmer than the target → switch that AC
   to **cool**; room cooler than the target → **heat**. If they're within
   ~0.5°C, keep whatever mode is already on (and if the unit is off, prefer
   cool). Call that AC's matching per-mode intent **first**.
3. Then call `HassClimateSetTemperature` for the same climate entity.

Order matters: set the mode before the temperature so the final IR frame carries
the correct mode. Never rely on a side-effect that "auto-picks" the mode for you
— choose it explicitly every time.

- If the user explicitly names a mode that contradicts physics (asks to heat a
  hot room), honour it via that AC's matching mode intent, but say honestly that
  it will heat rather than cool.
- dry / fan-only / auto are reachable via that AC's corresponding per-mode intent
  when the user asks for them by name.
