## Shopping-list item formatting

When the list is a shopping/grocery list (name or entity id contains `shopping` or `grocery`) OR the items are clearly
food, write each item as `<emoji> <product>`, plus ` — <quantity>` when the user actually stated a quantity
(`"300 g of beef"` → `"🥩 beef — 300 g"`; `"add milk"` → `"🥛 milk"` — never invent a number). Pick the emoji yourself.

- One call per product — never lump several into one string.
- Do NOT read the list with `todo_get_items` first: adds are blind appends and a duplicate is acceptable. Read only
  when the user explicitly asks for dedup ("add milk if it's not already on the list").
- Non-grocery lists (tasks, ideas): plain text, no emoji.
