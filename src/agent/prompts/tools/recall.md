Read the persistent user profile saved by `remember`.

Pass `null` to get the full profile. Pass a specific key (e.g. `"name"`, `"comfort_temp"`, `"alias_кондей"`) to read
just that one.

Call this BEFORE asking the user something they may have already told you — name, address, preferred temperature, device
nicknames. The profile is also injected into the system prompt on every turn, so most of the time you do not need to
call `recall` explicitly; use it when you need a specific value mid-turn or want to confirm a key exists.
