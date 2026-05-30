Delete a single profile entry by key.

Call this when the user explicitly asks to forget something ("forget my address", "delete my comfort temp") OR when a
previously-remembered value is now wrong and a fresh `remember` with a new value would leave a stale duplicate.

Do NOT call `forget` proactively to "clean up" — the user's data is theirs to keep.
