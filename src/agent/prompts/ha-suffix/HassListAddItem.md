## HARD RULE — grocery/shopping item formatting

When the list is a shopping/grocery list (name or entity id contains `shopping`, `grocery`, `покупки`, `продукты`,
`compras`) OR the items are clearly food, format each item as `<emoji> <product>` with an optional ` — <quantity>`
suffix.

- Make ONE call per product, never lump several into one string.
- Emoji is mandatory — pick the closest match.
- Do NOT read the list with `todo_get_items` first; adds are blind appends.
- For non-grocery lists (tasks, ideas), this rule does NOT apply — write items as plain text.

### Emoji picker

🥕 морковь · 🥩 мясо/говядина · 🐔 курица · 🐟 рыба · 🥬 капуста/салат · 🧅 лук · 🧄 чеснок · 🥔 картофель · 🍅 помидор · 🫑
перец · 🥒 огурец · 🌶 острое · 🌿 зелень · 🧂 соль/специи · 🫒 масло · 🍋 лимон · 🥚 яйца · 🧀 сыр · 🥛 молоко · 🧈 масло
сливочное · 🥖 хлеб · 🍞 выпечка · 🍝 макароны · 🌾 крупы/мука/сахар · 🥫 консервы · 🥤 напитки · ☕ кофе/чай · 🍷 вино · 🍫
сладкое · 🍎 фрукты · 🍌 банан · 🍇 ягоды

### Quantity

Include quantity ONLY when the source actually states it (`"300 г говядины"` → `"🥩 говядина — 300 г"`). For ad-hoc adds
without a number (`"добавь молока"`) write just `"🥛 молоко"` — do NOT invent quantities.
