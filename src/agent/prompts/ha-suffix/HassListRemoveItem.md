## HARD RULE — removing items from a list

HA matches items by their **exact `summary` string**, not by substring or fuzzy match.

- Before calling `HassListRemoveItem`, read the list with `todo_get_items` (status `needs_action`).
- Pass the `summary` verbatim to `HassListRemoveItem.item` — **including any emoji prefix and quantity suffix** (e.g. `🥛 безлактозное молоко`, not `безлактозное молоко`; `🥩 говядина — 300 г`, not `говядина`).
- If the user names an item without the emoji/quantity, resolve it to the exact summary from `todo_get_items` first.
- One call per item — never lump several into one string.
- If the item isn't in the list, do NOT retry with variations; tell the user it's already gone.
