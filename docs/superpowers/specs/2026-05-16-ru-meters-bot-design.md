# ru-meters-bot — Monthly Meter Readings Submitter

## Problem

The user owns an apartment in the Russian Federation they no longer live in. Each
month **ТГК-1** (`lk.tgc1.ru`) expects readings for several приборы
учёта (heat, hot water) on a single лицевой счёт. Meters do not move
because nobody lives there, so each month the user submits the **same
value as the previous month** — ТГК-1 accepts identical readings, only
the date advances.

The portal requires login + password (no API, no OAuth), is geo-blocked
to RU IPs, and shows captchas or "временная блокировка" from
data-center / non-RU exits.

Skipping a month accrues penalties at the provider's discretion and
forces a manual trip to the lichny kabinet to settle, so the monthly
submission needs to be **reliable, idempotent, and observable** — not
"best effort cron".

A second portal (**Петроэлектросбыт**, `ikus.pesc.ru`, electricity) is
explicitly out of scope for this iteration. The architecture below
keeps the per-portal seam clean so adding it later is additive.

The voice-assistant project already runs on a Raspberry Pi 5 with a
working Telegram bot, an auto-update pipeline, and conventions for
adapter-driven external integrations. The new service piggybacks on
that operational footprint without touching the voice-assistant
runtime.

## Goals

- Submit ТГК-1 readings once a month, starting on the first weekday
  on or after the 15th of the month at 12:00 MSK, retrying daily on
  weekdays until success or the retry budget runs out.
- For each прибор учёта, submit the value currently shown as "last
  reading" on the portal (i.e., do not advance the meter).
- Surface results in Telegram: a short success message confirming
  readings are submitted plus the current account balance
  (переплата / задолженность). On failure — error text.
- Idempotent across restarts and within a month — never submit twice
  for the same `(portal, period)`.
- Live next to voice-assistant but isolated: own image, own deps,
  own SQLite, slim runtime (Node 24 alpine, no chromium).

## Non-goals

- Submitting real (non-zero) usage. The apartment is empty; meters
  do not move.
- Bill download or payment.
- Multi-user / multi-apartment / multi-account configuration. One user,
  one apartment, hard-coded portal list, credentials in `.env`.
- Home Assistant integration. The bot is independent — no MCP, no
  shared agent, no scheduled-actions table.
- Петроэлектросбыт (`ikus.pesc.ru`). Deferred to a follow-up; the
  per-portal seam is in place so it is additive when picked up.
- Captcha-solving or browser fingerprint spoofing. The ТГК-1 REST API
  has no captcha on its endpoints; a bare HTTPS + Bearer token suffices.
  If anti-fraud ever surfaces (e.g. the WAF flags our exit IP), we swap
  exits (a config change) rather than escalate the cat-and-mouse.
- Cross-restart "fire missed schedules" replay beyond the submission
  window — if the Pi is off for the whole window, the user submits
  manually and we move on.

## Architecture

The service lives **inside the existing voice-assistant repository**
under `services/meters/`. This decision is operational, not technical:
one Pi, one solo developer, one `git pull`, one `.env`, one
`/update` Telegram command. The va auto-update pipeline already pulls
`deploy/docker-compose.yml` as a whole — adding two more services there
is free.

One container in `deploy/docker-compose.yml`:

- **`meters-bot`** — Node 24 (alpine) + `better-sqlite3` + native
  `fetch` (undici). **One-shot.** Not started by `docker compose up`;
  instead, a host systemd timer (`deploy/meters-bot.timer`, by analogy
  with `voice-assistant-update.timer`) runs `docker compose run --rm
meters-bot` on schedule. The container performs exactly one
  submission cycle and exits. Manual invocation is the same path —
  `docker compose run --rm meters-bot [--portal=tgc1] [--force]`.
  No `node-cron`, no daemon lifecycle, no in-process scheduler.
  ТГК-1's WAF doesn't geofence by region, so no RU proxy is needed —
  both ТГК-1 and Telegram are reached with the default dispatcher.

Scheduling lives on the host:

```ini
# /etc/systemd/system/meters-bot.timer
[Timer]
OnCalendar=Mon..Fri *-*-15..21 12:00:00
Persistent=true                  # if Pi was off at 12:00, fire on next boot inside window
[Install]
WantedBy=timers.target

# /etc/systemd/system/meters-bot.service
[Service]
Type=oneshot
WorkingDirectory=/opt/voice-assistant/deploy
ExecStart=/usr/bin/docker compose run --rm meters-bot
Environment=TZ=Europe/Moscow
```

The timer's `OnCalendar` uses the local system TZ; we set `TZ` on the
service so "12:00 МСК" is unambiguous regardless of the Pi's locale
configuration. `Persistent=true` makes systemd catch up a missed fire
after a reboot — within the 15-21 window the bot's own idempotency
keeps duplicate fires harmless.

```
services/meters/
├── package.json                 # type:module, Node 24, .ts imports — same conventions as root
├── tsconfig.json                # noEmit, allowImportingTsExtensions, strict
├── Dockerfile                   # FROM node:24-alpine (slim; no chromium)
├── src/
│   ├── index.ts                 # CLI entry: parses argv, runs one cycle, exits
│   ├── runOnce.ts               # the one-cycle function (gated by targetDay)
│   ├── period.ts                # currentPeriod(): 'YYYY-MM' in Europe/Moscow
│   ├── schedule.ts              # targetDay(year, month): first weekday >= 15
│   ├── storage/
│   │   ├── types.ts             # SubmissionsStore interface
│   │   ├── sqlite.ts            # better-sqlite3 implementation
│   │   └── migrations.ts        # TS string constants, like va/memory
│   ├── portals/
│   │   ├── types.ts             # Portal interface (single run() method)
│   │   └── tgc1.ts              # ТГК-1 REST driver (login + JSON endpoints)
│   └── notify/
│       ├── types.ts             # Notifier interface
│       └── telegram.ts          # uses TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID from .env
└── tests/
    ├── period.test.ts           # vitest
    ├── schedule.test.ts         # vitest
    ├── storage.test.ts          # vitest, in-memory SQLite
    └── tgc1.test.ts             # vitest with fetch mock (no live portal)
```

The root `package.json` is **not modified**. The root `tsconfig.json`
excludes `services/**`. CI is the only seam (see below).

### Data flow

```
systemd timer fires `docker compose run --rm meters-bot`
  ↓
process boots; reads .env; opens SQLite
  ↓
  if today < targetDay(currentMonth) and not --force → exit 0
  ↓
for each portal in [tgc1]:                        # pesc to be added later
  ↓
  store.getOrCreate(portal, currentPeriod) → row
  if row.status == 'done' or 'blocked' → skip
  if row.attempts >= 5 → mark blocked + notify + skip
  ↓
  { info, values } = await portal.run(deps)            // throws on failure
  ↓
  success: store.markDone(portal, period, values); notify.success(portal, info, values)
  failure: store.markFailed(portal, period, error); notify.failure(...)
  ↓
process exits with code 0 (success or recoverable failure) or 1 (unexpected)
```

`targetDay(currentMonth)` returns the first Mon-Fri date on or after
the 15th. The systemd timer fires every weekday in 15-21, but the
process gates itself on `targetDay` so the first 0-2 fires of the
window no-op cheaply (no network call). This naturally gives 5-7
retry attempts.

On the last fire of the window (the latest weekday on/before day 21),
if any portal is still not `done`, the process emits a one-shot
"submission window closed, please submit manually" message and sets
`notified_window_closed = 1`. The next month starts fresh on the next
`targetDay`.

### Portal interface

```ts
export interface MeterReading {
  meter: string; // serial as shown on the portal
  kind: string; // "ГВС м3" | "Отопление" | "Электричество день" | ...
  value: number; // what we actually submitted
}

export interface AccountInfo {
  accountId: string; // лицевой счёт as shown on the portal
  balanceText: string; // raw, as shown on the portal, e.g. "переплата N руб"
}

export interface PortalDeps {
  login: string;
  password: string;
  lastSubmittedValueFor(meter: string): number | null;
  today(): Date;
}

export interface Portal {
  readonly name: 'tgc1';
  /**
   * Logs in, reads account balance and the device list, submits readings
   * for every counter where it's accepted, verifies the new `dtLastReading`
   * advanced to today. Throws on any unrecoverable failure; partial success
   * also throws — the storage row's last_error encodes what failed.
   */
  run(deps: PortalDeps): Promise<{ info: AccountInfo | null; values: MeterReading[] }>;
}
```

The single `run()` method merges the previous `fetchAccountInfo` and
`submit` because the REST flow naturally does both as part of one
authenticated session.

### ТГК-1 REST flow

All four calls go to `https://lk.tgc1.ru`. Mandatory request headers
(without them the WAF returns HTML 403 «Доступ запрещён»):

```
User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 ...
Accept:     application/json
Origin:     https://lk.tgc1.ru
Referer:    https://lk.tgc1.ru/fl/      (or /fl/login for the auth call)
```

1. **Login.** `POST /api/security/auth/login/fl` with JSON
   `{ username, password }` from `TGC1_LOGIN` / `TGC1_PASSWORD`.
   Response 200 `{ accessToken, type: "Bearer", refreshToken }`.
   JWT TTL ≈ 1 hour — one run makes ~4 requests in 2 seconds, so no
   refresh logic is needed; a stale-token 401 simply fails the run and
   the next cron tick gets a fresh token.

2. **Account balance.** `GET /api/fl/dashboard/debt` with
   `Authorization: Bearer <jwt>`. Response 200
   `{ accountList: string[], sm: number }`. `sm` is the aggregate:
   negative = переплата, positive = задолженность, 0 = нулевой
   расчёт. The Telegram-facing `balanceText` is built in code from
   `sm` and `Math.abs(sm).toFixed(2)`. `accountList` becomes
   `AccountInfo.accountId` (multiple accounts joined with commas;
   unlikely in practice).

3. **Device list.** `GET /api/fl/device` returns an array of
   `{ id, number, serviceName, lastReading, dtLastReading, enabled,
requiredVerification, verificationWarning, ... }`. Per device:
   - `enabled: true` → submit step 4 with `value = lastReading`.
   - `enabled: false` and `dtLastReading == today` (МСК,
     `DD.MM.YYYY`) → already submitted today; mark as success, skip
     POST.
   - `enabled: false` and `dtLastReading != today` → real refusal;
     throw with a clear message, do not POST.
   - `requiredVerification` or `verificationWarning: true` → log a
     warning but proceed (verification deadlines are a year out;
     we don't gate on them).
   - Prev sanity check against
     `storage.lastSubmittedValue('tgc1', number)`: if cached value
     differs from `lastReading` by more than `0.001`, throw and ask
     the user to investigate.

4. **Submit.** `POST /api/fl/device/create-reading` with
   `{ counterId: <id>, value: <Number(lastReading)> }`. On HTTP 2xx
   we treat it as accepted (the response body shape is not relied on).
   On HTTP 4xx the response is parsed as
   `{ message, details: [{ field, errorMessage }] }` and surfaced in
   the error message.

5. **Verify.** After ~1 second wait, re-fetch `/api/fl/device` and
   confirm `dtLastReading == today` for every counter we submitted.
   Mismatch → throw.

### Storage schema

```sql
CREATE TABLE submissions (
  portal TEXT NOT NULL,                  -- 'tgc1' | 'pesc'
  period TEXT NOT NULL,                  -- 'YYYY-MM' in Europe/Moscow
  status TEXT NOT NULL,                  -- 'pending' | 'done' | 'failed' | 'blocked'
  attempts INTEGER NOT NULL DEFAULT 0,
  submitted_values TEXT,                 -- JSON: MeterReading[]
  account_info TEXT,                     -- JSON: AccountInfo
  last_error TEXT,
  last_attempt_at INTEGER,
  submitted_at INTEGER,
  notified_window_closed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (portal, period)
);
```

`notified_window_closed` is the one-shot flag for the "manual action
needed" Telegram after day 21.

Migrations are TS string constants (mirrors va's pattern). v1 creates
the table; future schema bumps add `v2`, `v3` etc. as needed. There is
no out-of-the-box ORM — `better-sqlite3` is used directly with small
typed helpers.

### Configuration (.env additions)

```
# RU exit proxy
# No proxy: ТГК-1 reachable from any IP, Telegram likewise.

# ТГК-1
TGC1_LOGIN=...
TGC1_PASSWORD=...

# Optional knobs
METERS_DRY_RUN=0                         # 1 = login + read device list, skip POST
METERS_DATA_DIR=/app/data                # sqlite
LOG_LEVEL=info

# Reused from voice-assistant (already present in .env):
# TELEGRAM_BOT_TOKEN
# TELEGRAM_CHAT_ID
# TZ (must be Europe/Moscow for the cron to fire on the correct calendar day)
```

`.env.example` in `services/meters/` documents the meters-specific keys
without duplicating va keys.

### Notifications

Telegram messages are plain text (MarkdownV2 is overkill here).
Concrete per-meter values are not surfaced — the user only cares about
the **fact** of submission and the account balance. Three templates:

```
✓ ТГК-1 за 2026-05: показания поданы (2 счётчика).
💰 ЛС <accountId>: <balanceText>
```

```
✗ ТГК-1 за 2026-05 — попытка 3/5: POST /api/fl/device/create-reading → HTTP 400: Validation Failed (value=must be positive)
   Повтор завтра.
```

```
⚠ Окно подачи показаний закрыто (21 мая). Не подано: ТГК-1 за 2026-05.
   Подайте, пожалуйста, вручную.
```

The exact meter values are still recorded in
`submissions.submitted_values` for debugging / audit — they just don't
clutter the notification. Error text comes from the REST response body
(`message` + `details[]`) and is preserved verbatim in
`last_error` for inspection via SQLite.

### Error handling and retries

- **Within a run:** a portal exception is caught at the per-portal
  level so one portal's failure doesn't skip the others.
- **Across runs:** failed rows remain `pending` (the `status` field
  encodes the latest attempt; "done or not done" is what matters).
  `attempts` increments on each try. At `attempts == 5` we mark
  `blocked` and notify once; no more attempts that period.
- **On the last fire of the window:** the run on the latest weekday
  in 15-21 checks every non-done row and emits the "window closed"
  message if `notified_window_closed` is 0, then sets it. The next
  period starts fresh on `targetDay` of the following month. The
  "last fire" is detected purely from today's date and `targetDay` —
  no extra timer.
- **Process crash mid-submit:** worst case is a duplicate submission
  attempt next day. ТГК-1 simply records the same value with a new
  date — harmless. ПЭС would reject `prev + 0.01` the second time
  and return an error visible to us — we mark `done` only on confirmed
  success, so the user gets a misleading "failed" Telegram once.
  Acceptable for a rare crash scenario; not worth a distributed-lock
  to fix.

### Testing

- **vitest** for `period`, `schedule`, `storage`, and `Tgc1Portal`
  with a `fetch` mock. The portal tests route by URL and return
  canned JSON for each endpoint (login → JWT, debt → balance,
  device → list, create-reading → empty 200, then re-fetch device
  → updated `dtLastReading`). Failure cases (HTTP 400 with
  `ApiError`, WAF HTML 403, `enabled:false` semantics, cached-prev
  mismatch, verify mismatch) all live in this single file.
- **Local debug loop:** `METERS_DRY_RUN=1 node --env-file=../../.env
src/index.ts --portal=tgc1 --force` logs in and prints the device
  list without POSTing readings.
- **NO** end-to-end tests against the live portal. Live verification
  is a manual `--force` run during the submission window.

### CI / build / deploy

- `.github/workflows/ci.yml` has a sibling matrix job that:
  - Works in `services/meters/`
  - Builds the meters Dockerfile, tags
    `ghcr.io/maxmaxme/ru-meters-bot:latest` and `:sha-<short>`.
  - Pushed on push-to-main, same as va.
- `deploy/docker-compose.yml` defines the one meters-bot service.
  `deploy/update.sh` runs `docker compose pull` (which fetches the new
  meters-bot image) and `docker compose up -d`. Since meters-bot has
  no restart policy, `up -d` is a no-op for it; the next systemd-timer
  fire uses the new image.
- `/update` Telegram command works as before.
- **First-time setup on the Pi** (one-off, not idempotent with
  `update.sh`): copy `deploy/meters-bot.{service,timer}` into
  `/etc/systemd/system/`, `systemctl daemon-reload`, `systemctl
enable --now meters-bot.timer`. Documented in `deploy/README.md`
  alongside the existing va-update-listener instructions.

### Local development (macOS, no Docker required)

The one-shot model means `index.ts` is just a Node script — runnable
directly from a laptop without building any image:

```bash
cd services/meters/
npm install
node --env-file=../../.env src/index.ts --portal=tgc1 --force
```

`METERS_DRY_RUN=1` logs in and fetches the device list without
POSTing any readings — useful while iterating on selectors or
diagnosing WAF behaviour.

### Operational considerations

- **Geofencing.** ТГК-1's WAF does not geo-block — the bot reaches the
  REST endpoints from any IP. If that ever changes, we'd reintroduce a
  scoped SOCKS5 proxy at the `fetch` dispatcher level (one file, ~30
  lines); the public Portal interface doesn't need to change.
- **Credential leakage.** `.env` is git-ignored; never logged. The
  JWT obtained from `/api/security/auth/login/fl` lives in memory for
  the duration of the run and is dropped on exit. Error messages
  surface the REST `message` + `details[]` verbatim — none of which
  carry the token.
- **Pi resources.** Nothing runs between fires. At fire time
  meters-bot starts on `node:24-alpine` (~30 MB RSS), makes 4 HTTPS
  requests over a couple of seconds, then exits.
- **Manual / first-run trigger.** Same command as the timer:
  `docker compose run --rm meters-bot [--portal=tgc1] [--force]`.
  `--force` ignores both the `targetDay` gate and the `done` /
  `blocked` row status (still respects the `attempts` cap so a
  hand-typo doesn't burn through retries). Only one meters-bot
  process runs at a time, so SQLite has no concurrency concern; WAL
  mode is still enabled defensively.

## Open questions

These are non-blocking for the spec — captured here so they're not
forgotten and filled during implementation:

1. **ТГК-1 meter count.** The reverse-engineered device list shows
   ГВС + Отопление; ХВС (cold water) is typically Водоканал, not
   ТГК-1, but worth confirming on the live account that only two
   counters come back from `/api/fl/device`.
2. **Cron window.** 15-21 inclusive, weekdays only, gives 5 attempts
   in the worst case (15 falls on a Monday → submissions Mon-Fri). If
   ТГК-1's real deadline is later in the month, we can extend.
3. **First-run bootstrap.** Before the first successful submission,
   we have no cached `lastSubmittedValue` for the "prev sanity check".
   The check is skipped when the cache is empty (first submission of
   any kind for that meter).

## Future-proofing notes

- **Adding Петроэлектросбыт.** New file `portals/pesc.ts` implementing
  the same `Portal` interface plus its own strategy (`prev + 0.01` per
  tariff field). One-line addition to the portal list in `runOnce`.
  `.env` gains
  `PESC_LOGIN` / `PESC_PASSWORD`. The `Portal['name']` union extends to
  `'tgc1' | 'pesc'`. No other structural changes.
- **Additional RF portals** (gas, internet, водоканал) follow the same
  template.
- If the user starts actually living in the apartment, the strategy
  moves from "submit prev" to "user-provided reading". The
  cron-driven model becomes manual: same code, called on-demand from
  a CLI or Telegram command. Out of scope today.
