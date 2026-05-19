**For CLIMATE entities** (`Кондиционер` and similar): this resumes the unit's LAST hvac_mode (could be heat, cool, dry, …). If the user named a specific mode:

- If `HassClimateSetHvacMode` is available, use IT instead — it sets the mode and powers on in one call.
- If not, call `HassTurnOn` AND tell the user honestly that you cannot guarantee the mode matched their request (e.g. "включил кондиционер, но режим могу только тот, что был выставлен в последний раз — проверь, что нужный"). Do NOT claim the mode is what the user asked for without verifying via `GetLiveContext`.
