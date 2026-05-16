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
  (переплата / задолженность). On failure — error text + screenshot
  path.
- Idempotent across restarts and within a month — never submit twice
  for the same `(portal, period)`.
- Live next to voice-assistant but isolated: own image, own deps,
  own SQLite, no Playwright / chromium leakage into the va image.

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
- Captcha-solving services or stealth browser fingerprinting beyond
  Playwright defaults. If the chosen RU exit triggers anti-fraud, we
  swap exits (a config change) rather than escalate the cat-and-mouse.
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

Two containers in `deploy/docker-compose.yml`, with different
lifecycles:

1. **`sing-box-ru`** — sing-box proxy. Always-on
   (`restart: unless-stopped`). Reads a single VLESS URL from
   `RU_PROXY_URL` (`.env`), parses it on container start,
   exposes SOCKS5 on `:1080` inside the docker network **and bound to
   `127.0.0.1:1080`** on the host (localhost-only, for the Mac-laptop
   dev loop — see "Local development"). Outbound to the proxy provider
   goes through docker's default network. Idle footprint ~30 MB;
   keeping it warm avoids paying TLS handshake on every meters-bot
   invocation.
2. **`meters-bot`** — Node 24 + Playwright + `better-sqlite3`.
   **One-shot.** Not started by `docker compose up`; instead, a host
   systemd timer (`deploy/meters-bot.timer`, by analogy with
   `voice-assistant-update.timer`) runs `docker compose run --rm
meters-bot` on schedule. The container performs exactly one
   submission cycle and exits. Manual invocation is the same path —
   `docker compose run --rm meters-bot [--portal=tgc1] [--force]`.
   No `node-cron`, no daemon lifecycle, no in-process scheduler.
   Playwright connects through `socks5://sing-box-ru:1080`; Telegram
   API is reached directly.

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
├── Dockerfile                   # FROM mcr.microsoft.com/playwright:latest (multi-arch)
├── src/
│   ├── index.ts                 # CLI entry: parses argv, runs one cycle, exits
│   ├── runOnce.ts               # the one-cycle function (gated by targetDay)
│   ├── period.ts                # currentPeriod(): 'YYYY-MM' in Europe/Moscow
│   ├── schedule.ts              # targetDay(year, month): first weekday >= 15
│   ├── storage/
│   │   ├── types.ts             # SubmissionsStore interface
│   │   ├── sqlite.ts            # better-sqlite3 implementation
│   │   └── migrations.ts        # TS string constants, like va/memory
│   ├── browser.ts               # Playwright launch with proxy, withPage() helper
│   ├── portals/
│   │   ├── types.ts             # Portal interface
│   │   └── tgc1.ts              # ТГК-1 driver (pesc.ts added later)
│   ├── notify/
│   │   ├── types.ts             # Notifier interface
│   │   └── telegram.ts          # uses TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID from .env
│   └── proxy/
│       └── parseVlessUrl.ts     # pure function: VLESS URL → sing-box config object
├── sing-box/
│   ├── Dockerfile               # FROM sagernet/sing-box + apk add nodejs
│   └── entrypoint.mjs           # imports parseVlessUrl, writes /tmp/config.json, exec sing-box
└── tests/
    ├── period.test.ts           # vitest
    ├── storage.test.ts          # vitest, in-memory SQLite
    ├── parseVlessUrl.test.ts    # vitest: valid URL + unsupported scheme
    └── tgc1.contract.test.ts    # vitest with HTML fixtures (no live portal)
```

The root `package.json` is **not modified** — Playwright stays out of
the va dependency graph. The root `tsconfig.json` excludes
`services/**`. CI is the only seam (see below).

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
  browser.withPage(proxy, async page => {
    const info = await portal.fetchAccountInfo?.(page)
    const values = await portal.submit(page)             // throws on failure
    return { info, values }
  })
  ↓
  success: store.markDone(portal, period, values); notify.success(portal, info, values)
  failure: store.markFailed(portal, period, error, screenshotPath); notify.failure(...)
  ↓
process exits with code 0 (success or recoverable failure) or 1 (unexpected)
```

`targetDay(currentMonth)` returns the first Mon-Fri date on or after
the 15th. The systemd timer fires every weekday in 15-21, but the
process gates itself on `targetDay` so the first 0-2 fires of the
window no-op cheaply (no Playwright launch). This naturally gives
5-7 retry attempts.

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

export interface Portal {
  readonly name: 'tgc1';
  fetchAccountInfo(page: Page): Promise<AccountInfo>;
  /**
   * Logs in (if needed), submits readings for every meter on the account,
   * verifies "Дата последних показаний" advanced to today for each.
   * Throws on any unrecoverable failure; partial success (1 of 2 meters)
   * also throws — the storage row's last_error encodes which meter failed.
   */
  submit(page: Page): Promise<MeterReading[]>;
}
```

### ТГК-1 flow

`lk.tgc1.ru`, all interactions inside the SOCKS5 RU proxy:

1. **Login.** `goto /fl/login` → fill username / password from
   `TGC1_LOGIN` / `TGC1_PASSWORD` → submit. Wait for redirect to
   `/fl`.
2. **Account info.** On `/fl`, locate the "Задолженность" block and
   scrape the line "По лицевым счетам № `<accountId>` имеется
   `<переплата|задолженность>` в размере `<amount>` руб". Build
   `AccountInfo { accountId, balanceText }` and stash it on the
   submission row for later use in the notification.
3. **Readings page.** `goto /fl/readings`. The page lists one card per
   прибор учёта (`Прибор учёта №<meter>`). Each card contains:
   - A type label (`ГВС м3`, `Отопление`, …) — kept verbatim in
     `MeterReading.kind`.
   - The `Лицевой счёт` value (sanity-check against the account scraped
     in step 2).
   - A `Показания: <number>` line — this is **`prev`** (the last
     accepted reading).
   - A separate "Ввод показаний" sub-card with a `Дата: <today
DD.MM.YYYY>` field and an **empty input** plus a «ДОБАВИТЬ» button.
4. **For each card, in order:**
   - Parse `prev` from the `Показания:` line (handle `,` and `.` as
     decimal separator).
   - Sanity-check against `storage.lastSubmittedValue('tgc1', meter)`
     if any: if portal's `prev` differs from our cached value by more
     than `0.001`, **bail** for this period and notify "prev на
     портале не совпадает с нашим кэшем — подайте вручную". This is
     the safety net against unnoticed manual submissions or portal
     resets.
   - Type `prev` into the input (string form, dot separator, the
     portal accepts both but dot is unambiguous).
   - Click «ДОБАВИТЬ».
   - Wait for the network request to settle and the card to re-render.
   - Verify the `Дата последних показаний` field inside the same card
     now reads today's date (`DD.MM.YYYY` in Europe/Moscow). On
     mismatch — throw, capture screenshot, retry next day.
   - Record `MeterReading { meter, kind, value: prev }`.
5. Return the array. The caller marks the period `done` only if every
   card was confirmed.

This flow assumes meters appear in a stable order across page renders.
We do not rely on it — each card carries its own meter number, which
we use as the de-facto key.

### Sing-box URL parser

The sing-box image is built locally from a thin Dockerfile that extends
the official `ghcr.io/sagernet/sing-box` with Node:

```dockerfile
FROM ghcr.io/sagernet/sing-box:latest
RUN apk add --no-cache nodejs
COPY entrypoint.mjs /entrypoint.mjs
COPY parseVlessUrl.js /parseVlessUrl.js
ENTRYPOINT ["node", "/entrypoint.mjs"]
```

`parseVlessUrl.ts` (compiled to plain JS at image build time, or
shipped as `.ts` and consumed by Node 24's native TS stripping like the
rest of the project) is a pure function:

```ts
export function parseVlessUrl(url: string): SingBoxConfig;
```

It accepts a VLESS URL of the form:

```
vless://<uuid>@<host>:<port>?security=reality&type=tcp&flow=xtls-rprx-vision
  &sni=<sni>&pbk=<pubkey>&sid=<shortid>&fp=chrome#<label>
```

and returns the sing-box config object below. Any other scheme throws
on startup with a clear error — easier to debug than letting sing-box
fail later. Support for Trojan / Shadowsocks can be added when actually
needed.

Parsing is done with Node's built-in `URL` and `URLSearchParams`. The
entrypoint reads `RU_PROXY_URL`, calls `parseVlessUrl`, writes the
result as `/tmp/config.json`, then `exec`s sing-box. Output:

```json
{
  "log": { "level": "info" },
  "inbounds": [
    {
      "type": "socks",
      "tag": "in",
      "listen": "0.0.0.0",
      "listen_port": 1080
    }
  ],
  "outbounds": [
    {
      "type": "vless",
      "tag": "out",
      "server": "<host>",
      "server_port": 443,
      "uuid": "<uuid>",
      "flow": "xtls-rprx-vision",
      "tls": {
        "enabled": true,
        "server_name": "cloudflare.com",
        "utls": { "enabled": true, "fingerprint": "chrome" },
        "reality": {
          "enabled": true,
          "public_key": "<pbk>",
          "short_id": "<sid>"
        }
      }
    }
  ]
}
```

The entrypoint replaces itself with sing-box via Node's
`child_process.spawnSync` invoking `execve` (or simpler — `child =
spawn('sing-box', ['run', '-c', '/tmp/config.json'], { stdio:
'inherit' })` then propagate SIGTERM / SIGINT explicitly). The wrapper
is a few dozen lines and a non-issue.

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
  last_error_screenshot TEXT,            -- path relative to /app/data
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
RU_PROXY_URL=vless://...                 # VLESS+Reality only for now

# ТГК-1
TGC1_LOGIN=...
TGC1_PASSWORD=...

# Optional knobs
METERS_DRY_RUN=0                         # 1 = login + reach form, skip submit
METERS_HEADED=0                          # 1 = launch chromium with --headed (debug)
METERS_DATA_DIR=/app/data                # sqlite + screenshots
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
✗ ТГК-1 за 2026-05 — попытка 3/5: TimeoutError waiting for «Добавить» on meter <serial>
   Скриншот: /app/data/screenshots/tgc1-2026-05-attempt-3.png
   Повтор завтра.
```

```
⚠ Окно подачи показаний закрыто (21 мая). Не подано: ТГК-1 за 2026-05.
   Подайте, пожалуйста, вручную.
```

The exact meter values are still recorded in
`submissions.submitted_values` for debugging / audit — they just don't
clutter the notification.

Screenshots are stored in the data volume; on failure the most recent
one is referenced by absolute path. We don't ship them through
Telegram as photo attachments (keeps the implementation single-message,
text-only); the user SSHs to the Pi or runs `docker cp` if they want
to inspect.

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
  (because `prev` advanced after the first success) and return an
  error visible to us — we mark `done` only on confirmed success, so
  the user gets a misleading "failed" Telegram once. Acceptable for a
  rare crash scenario; not worth a distributed-lock to fix.

### Testing

- **vitest** for `period`, `storage`, portal "contract" tests that
  feed canned HTML fixtures into a portal-specific `extractAccountInfo`
  / `findMeterCards` pure-function layer. The Playwright integration
  layer is **not** exercised in CI — too brittle, requires RU IP and
  live credentials.
- **vitest** for `parseVlessUrl`: one positive test against a sample
  URL with a known expected `SingBoxConfig`, one negative test for
  an unsupported scheme (`trojan://...`, `ss://...`) — must throw.
- **Local debug loop:** `METERS_DRY_RUN=1 METERS_HEADED=1 npm run
debug:tgc1` opens a visible Chromium through the proxy, runs the
  flow up to but not including the final «Добавить» click, and stops.
  Same for ПЭС once it's wired.
- **NO** end-to-end tests against live portals. `runOnce.ts` is
  structured so the per-portal `submit(page)` function is callable
  directly from a debug entry point for manual verification.

### CI / build / deploy

- `.github/workflows/build-image.yml` gains a sibling matrix job:
  - Working dir `services/meters/`
  - Builds the meters Dockerfile, tags
    `ghcr.io/maxmaxme/ru-meters-bot:arm64` and `:latest`.
  - Pushed on push-to-main, same as va.
- `deploy/docker-compose.yml` references both images. `deploy/update.sh`
  runs `docker compose pull` (which fetches the new meters-bot image
  too) and `docker compose up -d` (which only brings up services with
  a restart policy — sing-box-ru — and leaves the one-shot
  `meters-bot` definition untouched). The next systemd-timer fire
  uses the new image.
- `/update` Telegram command works as before.
- **First-time setup on the Pi** (one-off, not idempotent with
  `update.sh`): copy `deploy/meters-bot.{service,timer}` into
  `/etc/systemd/system/`, `systemctl daemon-reload`, `systemctl
enable --now meters-bot.timer`. Documented in `deploy/README.md`
  alongside the existing va-update-listener instructions.

### Local development (macOS, no Docker for the bot itself)

The one-shot model means `index.ts` is just a Node script — runnable
directly from a laptop without building any image:

```bash
cd services/meters/
npm install
npx playwright install chromium      # one-time
docker compose -f ../../deploy/docker-compose.yml up -d sing-box-ru
                                     # only the proxy in docker;
                                     # port 1080 bound to 127.0.0.1
node --env-file=../../.env src/index.ts --portal=tgc1 --force
```

The compose file binds sing-box-ru's port as `127.0.0.1:1080:1080`
(localhost-only, no external exposure). On the Pi this binding is
harmless — the meters-bot container reaches sing-box via the docker
network, not the host port — but it makes Mac dev a one-liner.

Alternatives, if avoiding Docker entirely for proxy:

- `brew install sing-box`, write `config.json` via a tiny helper
  `node services/meters/scripts/genSingBoxConfig.ts > /tmp/sb.json`
  (reuses `parseVlessUrl`), `sing-box run -c /tmp/sb.json` in another
  terminal.
- Use an existing VLESS client on the Mac (Hiddify, v2box, …) that
  exposes a local SOCKS5 — point `PROXY_URL` at it.

`METERS_HEADED=1` makes Playwright open a visible Chromium so you can
watch the flow and tweak selectors live. `METERS_DRY_RUN=1` reaches
the form without clicking «Добавить».

### Operational considerations

- **Exit IP quality.** The provided RU exit is labelled
  "Torrent-Node 🏴‍☠️" — IP pool is shared with P2P traffic and may be
  on Cloudflare / antifraud block lists. If portals captcha us, the
  fallback is (a) swap to a cleaner RU node if the provider has one,
  (b) rent a 200₽/mo RU VPS and run our own WireGuard endpoint. Both
  are config-only changes (different `RU_PROXY_URL`); the code does
  not change.
- **Credential leakage.** `.env` is git-ignored; never logged. Errors
  scrub query strings before logging (an OAuth redirect could embed
  tokens). Screenshots are written to a docker volume the user owns,
  not pushed anywhere.
- **Anti-bot evolution.** Playwright with `chromium` defaults plus
  human-ish typing delays should be enough for portals of this tier.
  If we ever need stealth (UA randomisation, fingerprint shaping),
  `playwright-extra` + `stealth` plugin is the path — added when
  needed, not preemptively.
- **Pi resources.** Between fires, only sing-box is running (~30 MB
  RAM). At fire time the meters-bot container starts, Playwright +
  Chromium load (~250 MB), one submission runs (~30 s), the container
  exits and the memory is freed. Total cost in a normal month: ~5
  short Chromium runs.
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

1. **ТГК-1 meter count.** Screenshot shows ГВС + Отопление; ХВС (cold
   water) is typically Водоканал, not ТГК-1, but worth confirming on
   the live account that only two cards appear on `/fl/readings`.
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
