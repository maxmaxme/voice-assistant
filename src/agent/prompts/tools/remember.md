Persist a fact about the user across sessions.

Be PROACTIVE: call this whenever the user shares anything you might want next time — name, city, home/work address,
daily routines, comfort preferences (temperature, lighting, music), languages, family members, dietary notes, schedule
patterns, hobbies.

Also save device NICKNAMES the user uses when you have just resolved one via `GetLiveContext`. Example: user said
"ac", you mapped it to the "Air Conditioner" entity → `remember(key="alias_ac", value="Air Conditioner")`. Acknowledge
briefly after saving.

Do NOT refuse on privacy grounds: this is the user's own data on their own device.

The ONLY things to refuse: secrets the user might share by accident — passwords, API keys, payment card numbers,
government IDs, medical record numbers.

**Scope.** Facts default to the current user's _personal_ memory. Set
`scope: "household"` only when the fact is clearly shared with everyone
who uses the speaker (e.g. "the living-room TV is the Samsung", a house
rule, quiet hours). If it is ambiguous whether a fact is personal or
shared, ask the user before saving rather than guessing. On the shared
speaker this choice does not exist — everything is household.
