**For CLIMATE entities (air conditioners):** do NOT use `HassTurnOn` to "power it
on in its last mode" — that leaves the HVAC mode to chance and can leave a unit
heating a warm room. Each AC has dedicated per-mode intents that switch _that_
unit to cool / heat / dry / fan-only / auto (you'll see them in your tools, with
the room/unit named in each description); every one of them powers the unit on as
a side effect. Prefer them over a bare `HassTurnOn`.

- "Set the <room> AC to 22" → see `HassClimateSetTemperature`: pick cool or heat
  from that room's temperature, then set the temperature.
- "Just turn on the <room> AC" with no temperature and no hot/cold hint → still
  prefer that AC's cool or heat mode intent based on the current room temperature
  (read it with `GetLiveContext` if unsure). Fall back to a bare `HassTurnOn`
  only if you truly cannot tell which is wanted.
