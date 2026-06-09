Sets the target temperature of a climate entity.

**Air conditioners in this house are IR-controlled.** If a unified AC-control
tool (e.g. `ac_control`) is in your tool list, prefer it over this tool — it
sets mode and temperature atomically in one call. Only fall back here when no
such tool is available.

When the user names a target temperature while the unit is off or in a
non-thermal mode, set an appropriate mode too — **cool** when the room is
warmer than the target, **heat** when it is cooler (check with `GetLiveContext`
if you don't already know the room temperature from this turn). Never claim
success for the temperature while leaving the unit off.
