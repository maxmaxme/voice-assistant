Read the persistent user profile saved by `remember`.

Pass `null` to get the full profile. Pass a specific key (e.g. `"name"`, `"comfort_temp"`, `"alias_ac"`) to read
just that one.

Call this BEFORE asking the user something they may have already told you — name, address, preferred temperature, device
nicknames. A snapshot of the profile is injected into the system prompt at the start of each conversation, so usually you
already have it — but that snapshot can be stale within a long-running conversation (e.g. a fact you saved with
`remember` earlier in the same conversation will not be in it). Call `recall` when you need the current value of a
specific key or want to confirm a key exists.
