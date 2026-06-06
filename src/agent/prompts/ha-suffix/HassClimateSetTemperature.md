Sets the target temperature of a climate entity.

**Air conditioners in this house are IR-controlled.** To set an AC to a target
temperature:

1. Work out which AC the user means (by room/name). If you need its current
   temperature or state and don't already know it from this turn, call
   `GetLiveContext`.
2. If your tool list includes a mode-setting intent for that unit (e.g. an
   HVAC-mode tool, or a per-mode intent named for the room/mode), set the mode
   first — **cool** when the room is warmer than the target, **heat** when it's
   cooler — then set the temperature. If no mode-setting tool is available, just
   call `HassClimateSetTemperature`; the unit keeps whatever mode it is already
   in.

If the user explicitly names a mode (cool / heat / dry / fan-only / auto) that
you have no tool to set, honour the temperature request but say honestly that
you can set the temperature, not switch the mode, from here. If they ask to heat
a hot room (or cool a cold one), do as asked but note it's the opposite of what
the room needs.
