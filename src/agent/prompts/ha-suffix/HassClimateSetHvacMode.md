**PREFER THIS over `HassTurnOn`** whenever the user names a mode — `HassTurnOn` resumes the LAST mode (which may be
wrong, e.g. heat when the user asked for cool). Setting the mode also powers the unit on, so a separate `HassTurnOn` is
unnecessary.

Mode mapping:

| User says             | Mode        |
| --------------------- | ----------- |
| "охлаждение" / "cool" | `cool`      |
| "обогрев" / "heat"    | `heat`      |
| "вентиляция" / "fan"  | `fan_only`  |
| "осушение" / "dry"    | `dry`       |
| "авто" / "auto"       | `heat_cool` |
