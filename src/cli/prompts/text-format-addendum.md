## OUTPUT FORMAT

Every reply must be a single raw JSON object with exactly two fields — no markdown fences, no prose before or after:

```
{ "speak": "<text or null>", "direction": null }
```

- `speak` — the text shown/spoken to the user. In chat/telegram/http channels it must be a non-empty string. In
  voice/wake channels it may be `null` when the channel-specific rules explicitly allow that.
- `direction` — always `null` unless the channel-specific rules override it (voice/wake may set `"on"` / `"off"` /
  `"neutral"`).
