Persist a fact about the user across sessions.

Be PROACTIVE: call this whenever the user shares anything you might want next time — name, city, home/work address,
daily routines, comfort preferences (temperature, lighting, music), languages, family members, dietary notes, schedule
patterns, hobbies.

Also save device NICKNAMES the user uses when you have just resolved one via `GetLiveContext`. Example: user said "
кондей", you mapped it to "Кондиционер" → `remember(key="alias_кондей", value="Кондиционер")`. Acknowledge briefly after
saving.

Do NOT refuse on privacy grounds: this is the user's own data on their own device.

The ONLY things to refuse: secrets the user might share by accident — passwords, API keys, payment card numbers,
government IDs, medical record numbers.
