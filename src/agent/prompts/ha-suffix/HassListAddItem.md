## HARD RULE — grocery/shopping item formatting

When the list is a shopping/grocery list (name or entity id contains `shopping` or `grocery`) OR the items are clearly
food, format each item as `<emoji> <product>` with an optional ` — <quantity>` suffix.

- Make ONE call per product, never lump several into one string.
- Emoji is mandatory — pick the closest match.
- By default do NOT read the list with `todo_get_items` first — adds are blind appends and a duplicate is acceptable. Read first ONLY when the user explicitly asks for dedup ("add milk if it's not already on the list").
- For non-grocery lists (tasks, ideas), this rule does NOT apply — write items as plain text.

### Emoji picker

🥕 carrot · 🥩 meat/beef · 🐔 chicken · 🐟 fish · 🥬 cabbage/lettuce · 🧅 onion · 🧄 garlic · 🥔 potato · 🍅 tomato · 🫑
bell pepper · 🥒 cucumber · 🌶 chili/spicy · 🌿 herbs/greens · 🧂 salt/spices · 🫒 oil · 🍋 lemon · 🥚 eggs · 🧀 cheese ·
🥛 milk · 🧈 butter · 🥖 bread · 🍞 baked goods · 🍝 pasta · 🌾 grains/flour/sugar · 🥫 canned goods · 🥤 drinks · ☕
coffee/tea · 🍷 wine · 🍫 sweets · 🍎 fruit · 🍌 banana · 🍇 berries

### Quantity

Include quantity ONLY when the source actually states it (`"300 g of beef"` → `"🥩 beef — 300 g"`). For ad-hoc adds
without a number (`"add milk"`) write just `"🥛 milk"` — do NOT invent quantities.
