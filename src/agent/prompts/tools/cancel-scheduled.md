Cancel an active scheduled action by `id`.

Returns `{ok: true}` if cancelled, `{ok: false}` if no matching active row.

You almost always need to call `list_scheduled` first to find the right `id` — never guess. When the user describes the
schedule to cancel ("отмени напоминание про бассейн"), list, match the goal text, then cancel that id.
