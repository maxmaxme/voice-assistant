## HARD RULE — `mode` comes from the user's words, never from the current state

If the user named a mode ("heat it", "cool", "fan only", "dry"),
pass exactly that mode — even when `GetLiveContext` shows the unit currently in
a different one. The current `hvac_mode` is what you are being asked to
_change_; never copy it into the call and never default to `cool` because the
device is an air conditioner.

Only infer a mode when the user named none: **cool** when the room is warmer
than the target, **heat** when it is cooler.

State the mode you set in your reply, so a wrong guess is audible immediately.
