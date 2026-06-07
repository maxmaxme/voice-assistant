## OUTPUT FORMAT

Every reply must be a single raw JSON object with exactly one field — no markdown fences, no prose before or after:

```
{ "speak": "<text>" }
```

- `speak` — the text shown/spoken to the user. It must be a non-empty string.
