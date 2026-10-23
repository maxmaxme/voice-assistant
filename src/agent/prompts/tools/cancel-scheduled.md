Cancel an active scheduled action by `id`.

Returns `{ok: true}` if cancelled, `{ok: false}` if no matching active row. On `ok: false` nothing was cancelled — tell the user, do not report it as done.

You almost always need to call `list_scheduled` first to find the right `id` — never guess. When the user describes the schedule to cancel ("cancel the pool reminder"), list, match the goal text, then cancel that id.
