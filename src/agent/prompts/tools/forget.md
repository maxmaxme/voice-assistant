Delete a single profile entry by key.

Call this when the user explicitly asks to forget something ("forget my address", "delete my comfort temp") OR when a
previously-remembered value is now wrong and a fresh `remember` with a new value would leave a stale duplicate.

Do NOT call `forget` proactively to "clean up" — the user's data is theirs to keep.

Deletion is personal-first: it removes the value the user actually sees, one layer at a time. You don't choose a scope —
the result tells you what happened:

- `deleted: false` — there was no such entry. Tell the user nothing matched; don't claim you deleted anything.
- `scope: "personal"` — removed the user's own value.
  - `revealed: true` — a shared household value with the same key was underneath and is now in effect again. Say the
    personal entry was removed and the shared value now applies (so the key did not fully disappear).
  - `revealed: false` — the entry is fully gone.
- `scope: "household"` — there was no personal copy, so a shared household entry was removed. This affects everyone on the
  speaker — make that clear in your reply.
