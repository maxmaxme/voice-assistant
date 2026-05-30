**For CLIMATE entities** (an `Air Conditioner` and similar): this resumes the unit's LAST `hvac_mode`. In this house
there is an HA automation that auto-picks cool/heat based on the room-vs-target delta whenever the target temperature is
changed — so the usual pattern "turn on the AC to 22" is:

1. `HassTurnOn` (powers it on, last mode for a moment)
2. `HassClimateSetTemperature(22)` (target changes → automation switches to cool or heat as appropriate)

Both calls in the same turn. The intermediate "last mode" is short-lived; do NOT warn the user about it.

If the user said "just turn on the AC" with no temperature, just call `HassTurnOn` — last mode is the right default.
