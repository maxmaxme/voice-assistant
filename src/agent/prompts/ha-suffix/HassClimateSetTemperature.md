**NOTE:** setting temperature does NOT power the unit on, and does NOT change the HVAC mode.

If the user said "включи на 22 охлаждения" / "set to 22 cool":

- They named a mode → pair this with `HassClimateSetHvacMode` (which also powers the unit on; no separate `HassTurnOn` needed).
- They did NOT name a mode but the unit is currently `off` → also call `HassTurnOn` so the unit actually starts.
- They did NOT name a mode and the unit is already on → just set the temperature.

Issue all required calls in the same turn.
