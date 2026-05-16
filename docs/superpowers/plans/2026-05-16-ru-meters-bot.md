# ru-meters-bot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a one-shot Node service that submits monthly ТГК-1 meter readings (previous month's values, no advance) through a RU SOCKS5 proxy, reports outcome to Telegram, and is scheduled by a host systemd timer.

**Architecture:** New subdirectory `services/meters/` with its own `package.json`, `tsconfig.json`, `Dockerfile`, and test config — completely isolated from the voice-assistant runtime. Heavy use of pure functions (date/period/url/sql-fixture-driven DOM parsing) so the only thing untested in CI is the live Playwright integration. A second tiny container `sing-box-ru` (also new) hosts the SOCKS5 proxy. Host `systemd` runs `docker compose run --rm meters-bot` Mon-Fri 15-21 at 12:00 МСК.

**Tech Stack:** Node 24 (native TS stripping), TypeScript, Playwright (chromium), better-sqlite3, vitest, pino (logger), sing-box (Alpine + nodejs), Docker Compose, systemd timer, GitHub Actions multi-arch buildx.

---

## File map

Files created (all under repo root):

- `services/meters/package.json` — own deps (playwright, better-sqlite3, pino)
- `services/meters/tsconfig.json` — mirrors root conventions, includes only `src/` and `tests/`
- `services/meters/vitest.config.ts` — picks up `tests/**`
- `services/meters/.gitignore` — `node_modules`, `data/`, `screenshots/`
- `services/meters/Dockerfile` — Playwright base image
- `services/meters/.dockerignore`
- `services/meters/src/index.ts` — CLI entry
- `services/meters/src/runOnce.ts` — orchestration
- `services/meters/src/period.ts` — `currentPeriod()`
- `services/meters/src/schedule.ts` — `targetDay`, `lastWeekdayOfWindow`
- `services/meters/src/logger.ts` — pino wrapper
- `services/meters/src/storage/types.ts`
- `services/meters/src/storage/migrations.ts`
- `services/meters/src/storage/sqlite.ts`
- `services/meters/src/notify/types.ts`
- `services/meters/src/notify/telegram.ts`
- `services/meters/src/browser.ts`
- `services/meters/src/portals/types.ts`
- `services/meters/src/portals/tgc1.ts`
- `services/meters/src/portals/tgc1.dom.ts` — pure DOM helpers, separately testable
- `services/meters/src/proxy/parseVlessUrl.ts`
- `services/meters/sing-box/Dockerfile` — extends sing-box with node
- `services/meters/sing-box/entrypoint.mjs`
- `services/meters/tests/*` — vitest suites
- `services/meters/tests/fixtures/tgc1-readings.html`
- `deploy/meters-bot.service`
- `deploy/meters-bot.timer`

Files modified:

- `tsconfig.json` — add `"services/**"` to `exclude`
- `package.json` — no functional change, just ensures lint-staged covers new files (no edit needed — `*.{ts,js}` already matches)
- `deploy/docker-compose.yml` — append `sing-box-ru` and `meters-bot` services
- `.github/workflows/ci.yml` — add `meters-test`, `meters-typecheck`, `meters-build-image` jobs
- `CLAUDE.md` — short section on `services/meters/`
- `README.md` — one-paragraph mention + first-time systemd-timer install on the Pi
- `deploy/README.md` (if exists; else create) — systemd timer install steps

---

## Task 1: Scaffold `services/meters/` package

**Files:**

- Create: `services/meters/package.json`
- Create: `services/meters/tsconfig.json`
- Create: `services/meters/vitest.config.ts`
- Create: `services/meters/.gitignore`
- Create: `services/meters/src/.gitkeep`
- Create: `services/meters/tests/.gitkeep`
- Modify: `tsconfig.json` (root) — exclude `services/**`

- [ ] **Step 1: Create `services/meters/package.json`**

```json
{
  "name": "ru-meters-bot",
  "version": "0.1.0",
  "description": "Monthly meter-reading submitter for ТГК-1",
  "private": true,
  "type": "module",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "engines": {
    "node": ">=24.0.0"
  },
  "dependencies": {
    "better-sqlite3": "^11.5.0",
    "pino": "^9.4.0",
    "playwright": "^1.50.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.13",
    "@types/node": "^22.10.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Create `services/meters/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "types": ["node"]
  },
  "include": ["src/**/*", "tests/**/*"]
}
```

- [ ] **Step 3: Create `services/meters/vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
```

- [ ] **Step 4: Create `services/meters/.gitignore`**

```
node_modules/
data/
screenshots/
*.log
```

- [ ] **Step 5: Create placeholder dirs and update root tsconfig**

Create empty `services/meters/src/.gitkeep` and `services/meters/tests/.gitkeep`.

Modify `tsconfig.json` (root) — add `"exclude": ["services/**"]`:

```json
{
  "compilerOptions": { ... },
  "include": ["src/**/*", "tests/**/*"],
  "exclude": ["services/**"]
}
```

- [ ] **Step 6: Install + verify**

```bash
cd services/meters && npm install && npm run typecheck && cd ../..
npm run typecheck    # root unaffected
```

Expected: both pass.

- [ ] **Step 7: Commit**

```bash
git add services/meters tsconfig.json
git commit -m "feat(meters): scaffold package skeleton

- services/meters/ has own package.json, tsconfig, vitest config.
- Root tsconfig excludes services/** so va typecheck is unaffected."
```

---

## Task 2: `period.ts` — current period in Europe/Moscow

**Files:**

- Create: `services/meters/src/period.ts`
- Create: `services/meters/tests/period.test.ts`

- [ ] **Step 1: Write the failing test**

`services/meters/tests/period.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { currentPeriod } from '../src/period.ts';

describe('currentPeriod', () => {
  it('returns YYYY-MM in Europe/Moscow', () => {
    // 2026-05-16 00:30 UTC is 2026-05-16 03:30 MSK → period 2026-05
    expect(currentPeriod(new Date('2026-05-16T00:30:00Z'))).toBe('2026-05');
  });

  it('rolls over by Moscow midnight, not UTC midnight', () => {
    // 2026-05-31 22:00 UTC is 2026-06-01 01:00 MSK → period 2026-06
    expect(currentPeriod(new Date('2026-05-31T22:00:00Z'))).toBe('2026-06');
  });

  it('zero-pads single-digit months', () => {
    expect(currentPeriod(new Date('2026-01-15T10:00:00Z'))).toBe('2026-01');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd services/meters && npx vitest run tests/period.test.ts
```

Expected: FAIL with "cannot find module ../src/period.ts".

- [ ] **Step 3: Write minimal implementation**

`services/meters/src/period.ts`:

```ts
const TZ = 'Europe/Moscow';

export function currentPeriod(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(now);

  const year = parts.find((p) => p.type === 'year')?.value;
  const month = parts.find((p) => p.type === 'month')?.value;
  if (!year || !month) throw new Error('Intl.DateTimeFormat returned no year/month');
  return `${year}-${month}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/period.test.ts
```

Expected: 3/3 pass.

- [ ] **Step 5: Commit**

```bash
git add services/meters/src/period.ts services/meters/tests/period.test.ts
git commit -m "feat(meters): currentPeriod() returns YYYY-MM in Europe/Moscow"
```

---

## Task 3: `schedule.ts` — `targetDay` and `lastWeekdayOfWindow`

**Files:**

- Create: `services/meters/src/schedule.ts`
- Create: `services/meters/tests/schedule.test.ts`

- [ ] **Step 1: Write the failing test**

`services/meters/tests/schedule.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { targetDay, lastWeekdayOfWindow, isInWindow } from '../src/schedule.ts';

describe('targetDay', () => {
  it('returns 15 when 15th is a Monday', () => {
    // 2026-06-15 is a Monday
    expect(targetDay(2026, 6)).toBe(15);
  });

  it('returns 17 when 15th is a Saturday', () => {
    // 2026-08-15 is a Saturday → first weekday on/after is Mon 2026-08-17
    expect(targetDay(2026, 8)).toBe(17);
  });

  it('returns 16 when 15th is a Sunday', () => {
    // 2026-11-15 is a Sunday → first weekday is Mon 2026-11-16
    expect(targetDay(2026, 11)).toBe(16);
  });

  it('returns 15 when 15th is a Friday', () => {
    // 2026-05-15 is a Friday
    expect(targetDay(2026, 5)).toBe(15);
  });
});

describe('lastWeekdayOfWindow', () => {
  it('is the latest Mon-Fri in [15,21]', () => {
    // 2026-05: 15=Fri, 16=Sat, 17=Sun, 18=Mon..21=Thu → last weekday is 21
    expect(lastWeekdayOfWindow(2026, 5)).toBe(21);
  });

  it('skips back from Sat/Sun on day 21', () => {
    // 2026-02: 15=Sun, 21=Sat → last weekday in window is Fri 2026-02-20
    expect(lastWeekdayOfWindow(2026, 2)).toBe(20);
  });
});

describe('isInWindow', () => {
  it('true on day 15 if weekday and within month', () => {
    expect(isInWindow(2026, 5, 15)).toBe(true);
  });

  it('false on day 14', () => {
    expect(isInWindow(2026, 5, 14)).toBe(false);
  });

  it('false on day 22', () => {
    expect(isInWindow(2026, 5, 22)).toBe(false);
  });

  it('false on a weekend day inside 15-21', () => {
    expect(isInWindow(2026, 5, 16)).toBe(false); // Sat
    expect(isInWindow(2026, 5, 17)).toBe(false); // Sun
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/schedule.test.ts
```

Expected: FAIL (module not found).

- [ ] **Step 3: Write minimal implementation**

`services/meters/src/schedule.ts`:

```ts
/** 1 = Mon, ..., 5 = Fri, 6 = Sat, 0 = Sun (JS Date.getDay()). */
function isWeekday(year: number, month: number, day: number): boolean {
  // month is 1-12, Date expects 0-11
  const d = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return d >= 1 && d <= 5;
}

/** First Mon-Fri date on or after the 15th. Always in [15,21]. */
export function targetDay(year: number, month: number): number {
  for (let d = 15; d <= 21; d++) {
    if (isWeekday(year, month, d)) return d;
  }
  throw new Error(`No weekday in window for ${year}-${month}`); // unreachable
}

/** Latest Mon-Fri date in [15,21]. */
export function lastWeekdayOfWindow(year: number, month: number): number {
  for (let d = 21; d >= 15; d--) {
    if (isWeekday(year, month, d)) return d;
  }
  throw new Error(`No weekday in window for ${year}-${month}`); // unreachable
}

/** True if `day` is a weekday in [15,21]. */
export function isInWindow(year: number, month: number, day: number): boolean {
  if (day < 15 || day > 21) return false;
  return isWeekday(year, month, day);
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/schedule.test.ts
```

Expected: 10/10 pass.

- [ ] **Step 5: Commit**

```bash
git add services/meters/src/schedule.ts services/meters/tests/schedule.test.ts
git commit -m "feat(meters): targetDay/lastWeekdayOfWindow/isInWindow helpers"
```

---

## Task 4: `parseVlessUrl.ts` — VLESS URL → sing-box config

**Files:**

- Create: `services/meters/src/proxy/parseVlessUrl.ts`
- Create: `services/meters/tests/parseVlessUrl.test.ts`

- [ ] **Step 1: Write the failing test**

`services/meters/tests/parseVlessUrl.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseVlessUrl } from '../src/proxy/parseVlessUrl.ts';

const sample =
  'vless://uuid-aaaa-bbbb-cccc@example.com:443?security=reality&type=tcp&flow=xtls-rprx-vision&sni=cloudflare.com&fp=chrome&pbk=PUBKEY123&sid=SHORTID456#%F0%9F%87%B7%F0%9F%87%BA%20RU';

describe('parseVlessUrl', () => {
  it('parses a VLESS+Reality URL into a sing-box config object', () => {
    const cfg = parseVlessUrl(sample);

    expect(cfg.inbounds).toEqual([
      { type: 'socks', tag: 'in', listen: '0.0.0.0', listen_port: 1080 },
    ]);

    expect(cfg.outbounds).toHaveLength(1);
    const out = cfg.outbounds[0];
    expect(out).toMatchObject({
      type: 'vless',
      tag: 'out',
      server: 'example.com',
      server_port: 443,
      uuid: 'uuid-aaaa-bbbb-cccc',
      flow: 'xtls-rprx-vision',
    });
    expect(out.tls).toMatchObject({
      enabled: true,
      server_name: 'cloudflare.com',
      utls: { enabled: true, fingerprint: 'chrome' },
      reality: {
        enabled: true,
        public_key: 'PUBKEY123',
        short_id: 'SHORTID456',
      },
    });
  });

  it('throws on a non-VLESS scheme', () => {
    expect(() => parseVlessUrl('trojan://pw@x.example:443')).toThrow(/scheme/i);
    expect(() => parseVlessUrl('ss://abc@x.example:443')).toThrow(/scheme/i);
  });

  it('throws when required parameters are missing', () => {
    expect(() => parseVlessUrl('vless://uuid@example.com:443?security=reality&type=tcp')).toThrow(
      /pbk|sid|sni/,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/parseVlessUrl.test.ts
```

Expected: FAIL (module not found).

- [ ] **Step 3: Write minimal implementation**

`services/meters/src/proxy/parseVlessUrl.ts`:

```ts
export interface SingBoxConfig {
  log: { level: string };
  inbounds: Array<{
    type: 'socks';
    tag: string;
    listen: string;
    listen_port: number;
  }>;
  outbounds: Array<{
    type: 'vless';
    tag: string;
    server: string;
    server_port: number;
    uuid: string;
    flow: string;
    tls: {
      enabled: true;
      server_name: string;
      utls: { enabled: true; fingerprint: string };
      reality: { enabled: true; public_key: string; short_id: string };
    };
  }>;
}

function require_(value: string | null, name: string): string {
  if (!value) throw new Error(`Missing required URL parameter: ${name}`);
  return value;
}

export function parseVlessUrl(input: string): SingBoxConfig {
  if (!input.startsWith('vless://')) {
    throw new Error(`Unsupported scheme: ${input.slice(0, 16)}... (only vless:// is supported)`);
  }

  const u = new URL(input);
  const q = u.searchParams;

  return {
    log: { level: 'info' },
    inbounds: [{ type: 'socks', tag: 'in', listen: '0.0.0.0', listen_port: 1080 }],
    outbounds: [
      {
        type: 'vless',
        tag: 'out',
        server: u.hostname,
        server_port: Number(u.port || '443'),
        uuid: decodeURIComponent(u.username),
        flow: require_(q.get('flow'), 'flow'),
        tls: {
          enabled: true,
          server_name: require_(q.get('sni'), 'sni'),
          utls: { enabled: true, fingerprint: q.get('fp') ?? 'chrome' },
          reality: {
            enabled: true,
            public_key: require_(q.get('pbk'), 'pbk'),
            short_id: require_(q.get('sid'), 'sid'),
          },
        },
      },
    ],
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/parseVlessUrl.test.ts
```

Expected: 3/3 pass.

- [ ] **Step 5: Commit**

```bash
git add services/meters/src/proxy/parseVlessUrl.ts services/meters/tests/parseVlessUrl.test.ts
git commit -m "feat(meters): parseVlessUrl() converts a VLESS URL to sing-box config"
```

---

## Task 5: Storage types and shared domain types

**Files:**

- Create: `services/meters/src/storage/types.ts`

- [ ] **Step 1: Create the types file**

```ts
export type Status = 'pending' | 'done' | 'failed' | 'blocked';

export interface MeterReading {
  meter: string;
  kind: string;
  value: number;
}

export interface AccountInfo {
  accountId: string;
  balanceText: string;
}

export interface SubmissionRow {
  portal: string;
  period: string;
  status: Status;
  attempts: number;
  submittedValues: MeterReading[] | null;
  accountInfo: AccountInfo | null;
  lastError: string | null;
  lastErrorScreenshot: string | null;
  lastAttemptAt: number | null;
  submittedAt: number | null;
  notifiedWindowClosed: boolean;
}

export interface SubmissionsStore {
  getOrCreate(portal: string, period: string): SubmissionRow;
  markPending(portal: string, period: string): void;
  markDone(portal: string, period: string, values: MeterReading[], info: AccountInfo): void;
  markFailed(portal: string, period: string, error: string, screenshotPath: string | null): void;
  markBlocked(portal: string, period: string): void;
  markWindowClosedNotified(portal: string, period: string): void;
  lastSubmittedValueFor(portal: string, meter: string): number | null;
  close(): void;
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add services/meters/src/storage/types.ts
git commit -m "feat(meters): storage and domain type contracts"
```

---

## Task 6: SQLite implementation of `SubmissionsStore`

**Files:**

- Create: `services/meters/src/storage/migrations.ts`
- Create: `services/meters/src/storage/sqlite.ts`
- Create: `services/meters/tests/storage.test.ts`

- [ ] **Step 1: Write the failing test**

`services/meters/tests/storage.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openSubmissionsStore } from '../src/storage/sqlite.ts';
import type { SubmissionsStore, MeterReading } from '../src/storage/types.ts';

const READINGS: MeterReading[] = [
  { meter: 'M1', kind: 'ГВС м3', value: 15.013 },
  { meter: 'M2', kind: 'Отопление', value: 10.54 },
];

const INFO = { accountId: 'ACC', balanceText: 'переплата 1 руб' };

let store: SubmissionsStore;

beforeEach(() => {
  store = openSubmissionsStore(':memory:');
});

describe('SubmissionsStore', () => {
  it('getOrCreate returns a fresh pending row, then the same row on second call', () => {
    const a = store.getOrCreate('tgc1', '2026-05');
    expect(a).toMatchObject({
      portal: 'tgc1',
      period: '2026-05',
      status: 'pending',
      attempts: 0,
      submittedValues: null,
      accountInfo: null,
      notifiedWindowClosed: false,
    });

    const b = store.getOrCreate('tgc1', '2026-05');
    expect(b.attempts).toBe(0);
  });

  it('markDone records values, info, status, submittedAt', () => {
    store.getOrCreate('tgc1', '2026-05');
    store.markDone('tgc1', '2026-05', READINGS, INFO);

    const row = store.getOrCreate('tgc1', '2026-05');
    expect(row.status).toBe('done');
    expect(row.submittedValues).toEqual(READINGS);
    expect(row.accountInfo).toEqual(INFO);
    expect(row.submittedAt).not.toBeNull();
  });

  it('markFailed increments attempts and records error', () => {
    store.getOrCreate('tgc1', '2026-05');
    store.markFailed('tgc1', '2026-05', 'TimeoutError', '/data/s1.png');
    store.markFailed('tgc1', '2026-05', 'TimeoutError again', '/data/s2.png');

    const row = store.getOrCreate('tgc1', '2026-05');
    expect(row.attempts).toBe(2);
    expect(row.lastError).toBe('TimeoutError again');
    expect(row.lastErrorScreenshot).toBe('/data/s2.png');
    expect(row.status).toBe('failed');
  });

  it('markBlocked sets status to blocked', () => {
    store.getOrCreate('tgc1', '2026-05');
    store.markBlocked('tgc1', '2026-05');
    expect(store.getOrCreate('tgc1', '2026-05').status).toBe('blocked');
  });

  it('markWindowClosedNotified flips the one-shot flag', () => {
    store.getOrCreate('tgc1', '2026-05');
    expect(store.getOrCreate('tgc1', '2026-05').notifiedWindowClosed).toBe(false);
    store.markWindowClosedNotified('tgc1', '2026-05');
    expect(store.getOrCreate('tgc1', '2026-05').notifiedWindowClosed).toBe(true);
  });

  it('lastSubmittedValueFor returns the most recent done value for a meter', () => {
    store.getOrCreate('tgc1', '2026-04');
    store.markDone('tgc1', '2026-04', READINGS, INFO);

    expect(store.lastSubmittedValueFor('tgc1', 'M1')).toBe(15.013);
    expect(store.lastSubmittedValueFor('tgc1', 'M2')).toBe(10.54);
    expect(store.lastSubmittedValueFor('tgc1', 'M3')).toBeNull();
    expect(store.lastSubmittedValueFor('pesc', 'M1')).toBeNull();
  });

  it('lastSubmittedValueFor ignores rows that are not done', () => {
    store.getOrCreate('tgc1', '2026-05');
    store.markFailed('tgc1', '2026-05', 'err', null);
    expect(store.lastSubmittedValueFor('tgc1', 'M1')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/storage.test.ts
```

Expected: FAIL (module not found).

- [ ] **Step 3: Write migrations**

`services/meters/src/storage/migrations.ts`:

```ts
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE submissions (
    portal TEXT NOT NULL,
    period TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    submitted_values TEXT,
    account_info TEXT,
    last_error TEXT,
    last_error_screenshot TEXT,
    last_attempt_at INTEGER,
    submitted_at INTEGER,
    notified_window_closed INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (portal, period)
  );
  CREATE INDEX idx_submissions_status ON submissions(status);
  `,
];
```

- [ ] **Step 4: Write SQLite store implementation**

`services/meters/src/storage/sqlite.ts`:

```ts
import Database from 'better-sqlite3';
import { MIGRATIONS } from './migrations.ts';
import type {
  AccountInfo,
  MeterReading,
  Status,
  SubmissionRow,
  SubmissionsStore,
} from './types.ts';

interface DbRow {
  portal: string;
  period: string;
  status: Status;
  attempts: number;
  submitted_values: string | null;
  account_info: string | null;
  last_error: string | null;
  last_error_screenshot: string | null;
  last_attempt_at: number | null;
  submitted_at: number | null;
  notified_window_closed: number;
}

function deserialize(row: DbRow): SubmissionRow {
  return {
    portal: row.portal,
    period: row.period,
    status: row.status,
    attempts: row.attempts,
    submittedValues: row.submitted_values
      ? (JSON.parse(row.submitted_values) as MeterReading[])
      : null,
    accountInfo: row.account_info ? (JSON.parse(row.account_info) as AccountInfo) : null,
    lastError: row.last_error,
    lastErrorScreenshot: row.last_error_screenshot,
    lastAttemptAt: row.last_attempt_at,
    submittedAt: row.submitted_at,
    notifiedWindowClosed: row.notified_window_closed === 1,
  };
}

export function openSubmissionsStore(path: string): SubmissionsStore {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');

  // Apply migrations idempotently (the file is created with a single v1 migration).
  const tableExists = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='submissions'")
    .get();
  if (!tableExists) {
    for (const sql of MIGRATIONS) db.exec(sql);
  }

  const selectStmt = db.prepare<{ portal: string; period: string }>(
    'SELECT * FROM submissions WHERE portal = @portal AND period = @period',
  );
  const insertStmt = db.prepare(
    `INSERT INTO submissions (portal, period) VALUES (@portal, @period)
     ON CONFLICT DO NOTHING`,
  );
  const lastValueStmt = db.prepare<{ portal: string }>(
    `SELECT submitted_values FROM submissions
     WHERE portal = @portal AND status = 'done'
     ORDER BY submitted_at DESC`,
  );

  function row(portal: string, period: string): SubmissionRow {
    const r = selectStmt.get({ portal, period }) as DbRow | undefined;
    if (!r) throw new Error(`submissions row not found after upsert: ${portal} ${period}`);
    return deserialize(r);
  }

  return {
    getOrCreate(portal, period) {
      insertStmt.run({ portal, period });
      return row(portal, period);
    },
    markPending(portal, period) {
      db.prepare(`UPDATE submissions SET status = 'pending' WHERE portal = ? AND period = ?`).run(
        portal,
        period,
      );
    },
    markDone(portal, period, values, info) {
      db.prepare(
        `UPDATE submissions
         SET status = 'done',
             submitted_values = ?,
             account_info = ?,
             submitted_at = ?,
             last_attempt_at = ?
         WHERE portal = ? AND period = ?`,
      ).run(JSON.stringify(values), JSON.stringify(info), Date.now(), Date.now(), portal, period);
    },
    markFailed(portal, period, error, screenshotPath) {
      db.prepare(
        `UPDATE submissions
         SET status = 'failed',
             attempts = attempts + 1,
             last_error = ?,
             last_error_screenshot = ?,
             last_attempt_at = ?
         WHERE portal = ? AND period = ?`,
      ).run(error, screenshotPath, Date.now(), portal, period);
    },
    markBlocked(portal, period) {
      db.prepare(`UPDATE submissions SET status = 'blocked' WHERE portal = ? AND period = ?`).run(
        portal,
        period,
      );
    },
    markWindowClosedNotified(portal, period) {
      db.prepare(
        `UPDATE submissions SET notified_window_closed = 1 WHERE portal = ? AND period = ?`,
      ).run(portal, period);
    },
    lastSubmittedValueFor(portal, meter) {
      for (const r of lastValueStmt.iterate({ portal }) as IterableIterator<{
        submitted_values: string | null;
      }>) {
        const values = r.submitted_values ? (JSON.parse(r.submitted_values) as MeterReading[]) : [];
        const hit = values.find((v) => v.meter === meter);
        if (hit) return hit.value;
      }
      return null;
    },
    close() {
      db.close();
    },
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
npx vitest run tests/storage.test.ts
```

Expected: 7/7 pass.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add services/meters/src/storage services/meters/tests/storage.test.ts
git commit -m "feat(meters): SQLite SubmissionsStore with status / attempts / values"
```

---

## Task 7: Logger wrapper

**Files:**

- Create: `services/meters/src/logger.ts`

- [ ] **Step 1: Create the logger**

```ts
import pino from 'pino';

const root = pino({
  level: process.env.LOG_LEVEL ?? 'info',
});

export function createLogger(scope: string, bindings: Record<string, unknown> = {}) {
  return root.child({ scope, ...bindings });
}

export type Logger = ReturnType<typeof createLogger>;
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add services/meters/src/logger.ts
git commit -m "feat(meters): pino logger wrapper"
```

---

## Task 8: Telegram notifier

**Files:**

- Create: `services/meters/src/notify/types.ts`
- Create: `services/meters/src/notify/telegram.ts`
- Create: `services/meters/tests/telegram.test.ts`

- [ ] **Step 1: Define the interface**

`services/meters/src/notify/types.ts`:

```ts
import type { AccountInfo } from '../storage/types.ts';

export interface Notifier {
  success(input: {
    portal: string;
    period: string;
    meterCount: number;
    info: AccountInfo | null;
  }): Promise<void>;
  failure(input: {
    portal: string;
    period: string;
    attempt: number;
    maxAttempts: number;
    error: string;
    screenshotPath: string | null;
  }): Promise<void>;
  windowClosed(input: { portal: string; period: string }): Promise<void>;
}
```

- [ ] **Step 2: Write the failing test**

`services/meters/tests/telegram.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TelegramNotifier } from '../src/notify/telegram.ts';

let calls: Array<{ url: string; body: unknown }>;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  calls = [];
  fetchMock = vi.fn(async (url: string, init: { body?: string }) => {
    calls.push({ url, body: init.body ? JSON.parse(init.body) : null });
    return new Response('{"ok":true}', { status: 200 });
  });
});

describe('TelegramNotifier.success', () => {
  it('posts a formatted message with balance line', async () => {
    const n = new TelegramNotifier({
      token: 'T',
      chatId: '42',
      fetch: fetchMock as unknown as typeof fetch,
    });

    await n.success({
      portal: 'tgc1',
      period: '2026-05',
      meterCount: 2,
      info: { accountId: 'ACC', balanceText: 'переплата 1 руб' },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.telegram.org/botT/sendMessage');
    const body = calls[0].body as { chat_id: string; text: string };
    expect(body.chat_id).toBe('42');
    expect(body.text).toContain('✓ ТГК-1 за 2026-05');
    expect(body.text).toContain('2 счётчика');
    expect(body.text).toContain('ЛС ACC: переплата 1 руб');
  });

  it('omits balance line when info is null', async () => {
    const n = new TelegramNotifier({
      token: 'T',
      chatId: '42',
      fetch: fetchMock as unknown as typeof fetch,
    });

    await n.success({ portal: 'tgc1', period: '2026-05', meterCount: 2, info: null });
    const body = calls[0].body as { text: string };
    expect(body.text).not.toMatch(/ЛС/);
  });
});

describe('TelegramNotifier.failure', () => {
  it('mentions attempt/maxAttempts and the screenshot path', async () => {
    const n = new TelegramNotifier({
      token: 'T',
      chatId: '42',
      fetch: fetchMock as unknown as typeof fetch,
    });

    await n.failure({
      portal: 'tgc1',
      period: '2026-05',
      attempt: 3,
      maxAttempts: 5,
      error: 'TimeoutError',
      screenshotPath: '/data/s.png',
    });

    const body = calls[0].body as { text: string };
    expect(body.text).toContain('✗ ТГК-1 за 2026-05');
    expect(body.text).toContain('попытка 3/5');
    expect(body.text).toContain('TimeoutError');
    expect(body.text).toContain('/data/s.png');
  });
});

describe('TelegramNotifier.windowClosed', () => {
  it('emits the "submit manually" message', async () => {
    const n = new TelegramNotifier({
      token: 'T',
      chatId: '42',
      fetch: fetchMock as unknown as typeof fetch,
    });

    await n.windowClosed({ portal: 'tgc1', period: '2026-05' });
    const body = calls[0].body as { text: string };
    expect(body.text).toContain('⚠');
    expect(body.text).toContain('ТГК-1');
    expect(body.text).toContain('вручную');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
npx vitest run tests/telegram.test.ts
```

Expected: FAIL (module not found).

- [ ] **Step 4: Write the implementation**

`services/meters/src/notify/telegram.ts`:

```ts
import type { Notifier } from './types.ts';
import type { AccountInfo } from '../storage/types.ts';

const PORTAL_LABEL: Record<string, string> = {
  tgc1: 'ТГК-1',
};

function label(portal: string): string {
  return PORTAL_LABEL[portal] ?? portal;
}

export interface TelegramNotifierOptions {
  token: string;
  chatId: string;
  fetch?: typeof fetch;
}

export class TelegramNotifier implements Notifier {
  private readonly token: string;
  private readonly chatId: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: TelegramNotifierOptions) {
    this.token = opts.token;
    this.chatId = opts.chatId;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async success(input: {
    portal: string;
    period: string;
    meterCount: number;
    info: AccountInfo | null;
  }): Promise<void> {
    const lines = [
      `✓ ${label(input.portal)} за ${input.period}: показания поданы (${input.meterCount} счётчика).`,
    ];
    if (input.info) {
      lines.push(`💰 ЛС ${input.info.accountId}: ${input.info.balanceText}`);
    }
    await this.send(lines.join('\n'));
  }

  async failure(input: {
    portal: string;
    period: string;
    attempt: number;
    maxAttempts: number;
    error: string;
    screenshotPath: string | null;
  }): Promise<void> {
    const lines = [
      `✗ ${label(input.portal)} за ${input.period} — попытка ${input.attempt}/${input.maxAttempts}: ${input.error}`,
    ];
    if (input.screenshotPath) lines.push(`Скриншот: ${input.screenshotPath}`);
    lines.push('Повтор завтра.');
    await this.send(lines.join('\n'));
  }

  async windowClosed(input: { portal: string; period: string }): Promise<void> {
    await this.send(
      `⚠ Окно подачи показаний закрыто. Не подано: ${label(input.portal)} за ${input.period}.\n` +
        `Подайте, пожалуйста, вручную.`,
    );
  }

  private async send(text: string): Promise<void> {
    const url = `https://api.telegram.org/bot${this.token}/sendMessage`;
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: this.chatId, text }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '<no body>');
      throw new Error(`Telegram sendMessage failed: ${res.status} ${body}`);
    }
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
npx vitest run tests/telegram.test.ts
```

Expected: 4/4 pass.

- [ ] **Step 6: Commit**

```bash
git add services/meters/src/notify services/meters/tests/telegram.test.ts
git commit -m "feat(meters): Telegram notifier (success/failure/windowClosed)"
```

---

## Task 9: ТГК-1 DOM helpers (pure, fixture-tested)

**Files:**

- Create: `services/meters/tests/fixtures/tgc1-readings.html`
- Create: `services/meters/tests/fixtures/tgc1-balance.html`
- Create: `services/meters/src/portals/tgc1.dom.ts`
- Create: `services/meters/tests/tgc1.dom.test.ts`

> **Note:** the fixtures here are illustrative. The TDD discipline guarantees the helpers
> work against this canonical shape; real selectors are validated end-to-end during local
> Playwright debugging (see Task 14).

- [ ] **Step 1: Create the balance fixture**

`services/meters/tests/fixtures/tgc1-balance.html`:

```html
<!doctype html>
<html>
  <body>
    <main>
      <section class="account-summary">
        <h2>Задолженность</h2>
        <p>По лицевым счетам № 7060001472 имеется переплата в размере 75.18 руб.</p>
      </section>
    </main>
  </body>
</html>
```

- [ ] **Step 2: Create the readings fixture**

`services/meters/tests/fixtures/tgc1-readings.html`:

```html
<!doctype html>
<html>
  <body>
    <main>
      <article class="meter-card" data-meter="210214605">
        <h3>Прибор учета №210214605</h3>
        <p class="kind">ГВС м3</p>
        <p>Лицевой счет: <span class="account">7060001472</span></p>
        <p>Дата последних показаний: <span class="last-date">22.04.2026</span></p>
        <p>Показания: <span class="last-value">15.013</span></p>
        <form class="reading-form">
          <input name="value" value="" />
          <button type="submit">ДОБАВИТЬ</button>
        </form>
      </article>
      <article class="meter-card" data-meter="03599873">
        <h3>Прибор учета №03599873</h3>
        <p class="kind">Отопление</p>
        <p>Лицевой счет: <span class="account">7060001472</span></p>
        <p>Дата последних показаний: <span class="last-date">22.04.2026</span></p>
        <p>Показания: <span class="last-value">10.54</span></p>
        <form class="reading-form">
          <input name="value" value="" />
          <button type="submit">ДОБАВИТЬ</button>
        </form>
      </article>
    </main>
  </body>
</html>
```

- [ ] **Step 3: Write the failing DOM helper tests**

`services/meters/tests/tgc1.dom.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parseBalance, parseMeterCards } from '../src/portals/tgc1.dom.ts';

const here = dirname(fileURLToPath(import.meta.url));
const balanceHtml = readFileSync(resolve(here, 'fixtures/tgc1-balance.html'), 'utf8');
const readingsHtml = readFileSync(resolve(here, 'fixtures/tgc1-readings.html'), 'utf8');

describe('parseBalance', () => {
  it('extracts account id and the full balance phrase', () => {
    expect(parseBalance(balanceHtml)).toEqual({
      accountId: '7060001472',
      balanceText: 'переплата 75.18 руб',
    });
  });

  it('returns null when the section is missing', () => {
    expect(parseBalance('<html><body></body></html>')).toBeNull();
  });
});

describe('parseMeterCards', () => {
  it('extracts every meter card on the page', () => {
    const cards = parseMeterCards(readingsHtml);
    expect(cards).toHaveLength(2);
    expect(cards[0]).toMatchObject({
      meter: '210214605',
      kind: 'ГВС м3',
      accountId: '7060001472',
      lastDate: '22.04.2026',
      lastValue: 15.013,
    });
    expect(cards[1]).toMatchObject({
      meter: '03599873',
      kind: 'Отопление',
      lastValue: 10.54,
    });
  });

  it('parses values that use a comma as decimal separator', () => {
    const html = readingsHtml.replace('15.013', '15,013');
    const cards = parseMeterCards(html);
    expect(cards[0].lastValue).toBe(15.013);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

```bash
npx vitest run tests/tgc1.dom.test.ts
```

Expected: FAIL (module not found).

- [ ] **Step 5: Add a lightweight HTML parser dep + implementation**

Add `node-html-parser` to dependencies:

```bash
cd services/meters
npm install node-html-parser
```

Then `services/meters/src/portals/tgc1.dom.ts`:

```ts
import { parse } from 'node-html-parser';

export interface ParsedBalance {
  accountId: string;
  balanceText: string;
}

export interface ParsedMeterCard {
  meter: string;
  kind: string;
  accountId: string;
  lastDate: string; // 'DD.MM.YYYY'
  lastValue: number;
}

const BALANCE_RE = /№\s*(\d+)\s+имеется\s+(.+?)\.?$/u;

export function parseBalance(html: string): ParsedBalance | null {
  const root = parse(html);
  const section = root.querySelector('section.account-summary');
  if (!section) return null;
  const text = section.text.replace(/\s+/g, ' ').trim();
  const m = text.match(BALANCE_RE);
  if (!m) return null;
  return { accountId: m[1], balanceText: m[2].trim() };
}

function toNumber(raw: string): number {
  return Number(raw.replace(',', '.'));
}

export function parseMeterCards(html: string): ParsedMeterCard[] {
  const root = parse(html);
  const cards = root.querySelectorAll('article.meter-card');
  return cards.map((card) => {
    const meter = card.getAttribute('data-meter') ?? '';
    const kind = card.querySelector('.kind')?.text.trim() ?? '';
    const accountId = card.querySelector('.account')?.text.trim() ?? '';
    const lastDate = card.querySelector('.last-date')?.text.trim() ?? '';
    const lastValueRaw = card.querySelector('.last-value')?.text.trim() ?? '';
    return { meter, kind, accountId, lastDate, lastValue: toNumber(lastValueRaw) };
  });
}
```

- [ ] **Step 6: Run test to verify it passes**

```bash
npx vitest run tests/tgc1.dom.test.ts
```

Expected: 4/4 pass.

- [ ] **Step 7: Commit**

```bash
git add services/meters/src/portals/tgc1.dom.ts services/meters/tests/tgc1.dom.test.ts services/meters/tests/fixtures services/meters/package.json services/meters/package-lock.json
git commit -m "feat(meters): pure DOM helpers for ТГК-1 (parseBalance, parseMeterCards)"
```

---

## Task 10: Portal interface

**Files:**

- Create: `services/meters/src/portals/types.ts`

- [ ] **Step 1: Create the interface**

```ts
import type { Page } from 'playwright';
import type { AccountInfo, MeterReading } from '../storage/types.ts';

export interface PortalDeps {
  login: string;
  password: string;
  lastSubmittedValueFor(meter: string): number | null;
  today(): Date;
}

export interface Portal {
  readonly name: 'tgc1';
  fetchAccountInfo(page: Page): Promise<AccountInfo | null>;
  submit(page: Page, deps: PortalDeps): Promise<MeterReading[]>;
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add services/meters/src/portals/types.ts
git commit -m "feat(meters): Portal interface"
```

---

## Task 11: Browser launcher

**Files:**

- Create: `services/meters/src/browser.ts`

- [ ] **Step 1: Create the helper**

```ts
import { chromium, type Browser, type Page } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from './logger.ts';

const log = createLogger('browser');

export interface BrowserOptions {
  proxyUrl: string; // e.g. socks5://sing-box-ru:1080
  headed: boolean;
  screenshotDir: string;
}

export interface BrowserSession {
  page: Page;
  screenshotOnFailure(label: string): Promise<string | null>;
}

export async function withBrowser<T>(
  opts: BrowserOptions,
  fn: (sess: BrowserSession) => Promise<T>,
): Promise<T> {
  await mkdir(opts.screenshotDir, { recursive: true });

  const browser: Browser = await chromium.launch({
    headless: !opts.headed,
    proxy: { server: opts.proxyUrl },
  });
  const ctx = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    locale: 'ru-RU',
  });
  const page = await ctx.newPage();

  const sess: BrowserSession = {
    page,
    async screenshotOnFailure(label) {
      try {
        const path = join(opts.screenshotDir, `${label}-${Date.now()}.png`);
        await page.screenshot({ path, fullPage: true });
        return path;
      } catch (err) {
        log.warn({ err }, 'screenshotOnFailure failed');
        return null;
      }
    },
  };

  try {
    return await fn(sess);
  } finally {
    await browser.close().catch(() => undefined);
  }
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add services/meters/src/browser.ts
git commit -m "feat(meters): withBrowser helper (playwright + proxy + screenshot)"
```

---

## Task 12: ТГК-1 portal driver

**Files:**

- Create: `services/meters/src/portals/tgc1.ts`

> No unit test for this file — it's pure Playwright orchestration, exercised
> manually via local debug runs (Task 14). The DOM logic is already covered in
> Task 9; the screen interactions are too brittle for assertions in CI.

- [ ] **Step 1: Write the portal driver**

```ts
import type { Page } from 'playwright';
import type { AccountInfo, MeterReading } from '../storage/types.ts';
import type { Portal, PortalDeps } from './types.ts';
import { parseBalance, parseMeterCards } from './tgc1.dom.ts';
import { createLogger } from '../logger.ts';

const log = createLogger('portal:tgc1');

const BASE = 'https://lk.tgc1.ru';
const LOGIN_URL = `${BASE}/fl/login`;
const HOME_URL = `${BASE}/fl`;
const READINGS_URL = `${BASE}/fl/readings`;

function todayDdMmYyyy(today: Date): string {
  const fmt = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
  return fmt.format(today);
}

export class Tgc1Portal implements Portal {
  readonly name = 'tgc1' as const;

  async fetchAccountInfo(page: Page): Promise<AccountInfo | null> {
    if (!page.url().startsWith(HOME_URL)) {
      await page.goto(HOME_URL, { waitUntil: 'networkidle' });
    }
    const html = await page.content();
    return parseBalance(html);
  }

  async submit(page: Page, deps: PortalDeps): Promise<MeterReading[]> {
    await this.login(page, deps.login, deps.password);

    await page.goto(READINGS_URL, { waitUntil: 'networkidle' });
    const cards = parseMeterCards(await page.content());
    if (cards.length === 0) throw new Error('No meter cards found on /fl/readings');

    const result: MeterReading[] = [];
    const todayStr = todayDdMmYyyy(deps.today());

    for (const card of cards) {
      const cached = deps.lastSubmittedValueFor(card.meter);
      if (cached !== null && Math.abs(cached - card.lastValue) > 0.001) {
        throw new Error(
          `Cached prev (${cached}) for meter ${card.meter} differs from portal prev (${card.lastValue}) — refuse to submit`,
        );
      }

      const cardLocator = page.locator(`article.meter-card[data-meter="${card.meter}"]`);
      await cardLocator.locator('input[name="value"]').fill(String(card.lastValue));
      await Promise.all([
        page.waitForLoadState('networkidle'),
        cardLocator.getByRole('button', { name: /ДОБАВИТЬ/i }).click(),
      ]);

      // re-read after submit
      const after = parseMeterCards(await page.content()).find((c) => c.meter === card.meter);
      if (!after) throw new Error(`Meter ${card.meter} disappeared after submit`);
      if (after.lastDate !== todayStr) {
        throw new Error(
          `Meter ${card.meter}: lastDate after submit is ${after.lastDate}, expected ${todayStr}`,
        );
      }

      log.info({ meter: card.meter, value: card.lastValue }, 'meter submitted');
      result.push({ meter: card.meter, kind: card.kind, value: card.lastValue });
    }

    return result;
  }

  private async login(page: Page, login: string, password: string): Promise<void> {
    if (page.url().startsWith(HOME_URL)) return;
    await page.goto(LOGIN_URL, { waitUntil: 'networkidle' });
    await page.getByLabel(/логин|email|телефон/i).fill(login);
    await page.getByLabel(/пароль/i).fill(password);
    await Promise.all([
      page.waitForURL((url) => url.toString().startsWith(HOME_URL), { timeout: 15_000 }),
      page.getByRole('button', { name: /войти/i }).click(),
    ]);
  }
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add services/meters/src/portals/tgc1.ts
git commit -m "feat(meters): ТГК-1 portal driver (login + per-meter submit + verify)"
```

---

## Task 13: `runOnce.ts` — orchestration

**Files:**

- Create: `services/meters/src/runOnce.ts`
- Create: `services/meters/tests/runOnce.test.ts`

- [ ] **Step 1: Write the failing test**

`services/meters/tests/runOnce.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runOnce } from '../src/runOnce.ts';
import type { Portal, PortalDeps } from '../src/portals/types.ts';
import type { Page } from 'playwright';
import type { SubmissionsStore, MeterReading } from '../src/storage/types.ts';
import type { Notifier } from '../src/notify/types.ts';
import { openSubmissionsStore } from '../src/storage/sqlite.ts';

const READINGS: MeterReading[] = [
  { meter: 'M1', kind: 'ГВС', value: 1 },
  { meter: 'M2', kind: 'Отопление', value: 2 },
];

function makePortal(impl: Partial<Portal> = {}): Portal {
  return {
    name: 'tgc1',
    fetchAccountInfo: vi.fn(async () => ({ accountId: 'ACC', balanceText: 'переплата 1 руб' })),
    submit: vi.fn(async () => READINGS),
    ...impl,
  } as Portal;
}

function makeNotifier(): Notifier & { calls: Record<string, unknown[]> } {
  const calls = {
    success: [] as unknown[],
    failure: [] as unknown[],
    windowClosed: [] as unknown[],
  };
  return {
    calls,
    success: vi.fn(async (i) => void calls.success.push(i)),
    failure: vi.fn(async (i) => void calls.failure.push(i)),
    windowClosed: vi.fn(async (i) => void calls.windowClosed.push(i)),
  };
}

const withPageStub = async <T>(
  _: unknown,
  fn: (sess: {
    page: Page;
    screenshotOnFailure: (l: string) => Promise<string | null>;
  }) => Promise<T>,
): Promise<T> => fn({ page: {} as Page, screenshotOnFailure: async () => '/data/s.png' });

let store: SubmissionsStore;

beforeEach(() => {
  store = openSubmissionsStore(':memory:');
});

describe('runOnce', () => {
  it('skips entirely if today is before targetDay and not forced', async () => {
    const portal = makePortal();
    const notifier = makeNotifier();

    await runOnce({
      store,
      notifier,
      portals: [portal],
      withPage: withPageStub,
      portalDepsFor: () => ({
        login: 'l',
        password: 'p',
        lastSubmittedValueFor: () => null,
        today: () => new Date(),
      }),
      now: new Date('2026-05-10T09:00:00Z'),
      force: false,
    });

    expect(portal.submit).not.toHaveBeenCalled();
    expect(notifier.calls.success).toHaveLength(0);
  });

  it('runs on targetDay, marks done, notifies success', async () => {
    const portal = makePortal();
    const notifier = makeNotifier();

    // 2026-05-15 is Friday → targetDay = 15
    await runOnce({
      store,
      notifier,
      portals: [portal],
      withPage: withPageStub,
      portalDepsFor: () => ({
        login: 'l',
        password: 'p',
        lastSubmittedValueFor: () => null,
        today: () => new Date(),
      }),
      now: new Date('2026-05-15T09:00:00Z'),
      force: false,
    });

    expect(portal.submit).toHaveBeenCalledOnce();
    expect(notifier.calls.success).toHaveLength(1);
    expect(store.getOrCreate('tgc1', '2026-05').status).toBe('done');
  });

  it('skips a portal that is already done', async () => {
    const portal = makePortal();
    const notifier = makeNotifier();

    store.getOrCreate('tgc1', '2026-05');
    store.markDone('tgc1', '2026-05', READINGS, { accountId: 'ACC', balanceText: 'x' });

    await runOnce({
      store,
      notifier,
      portals: [portal],
      withPage: withPageStub,
      portalDepsFor: () => ({
        login: 'l',
        password: 'p',
        lastSubmittedValueFor: () => null,
        today: () => new Date(),
      }),
      now: new Date('2026-05-15T09:00:00Z'),
      force: false,
    });

    expect(portal.submit).not.toHaveBeenCalled();
  });

  it('records failure with screenshot and notifies', async () => {
    const portal = makePortal({
      submit: vi.fn(async () => {
        throw new Error('TimeoutError');
      }),
    });
    const notifier = makeNotifier();

    await runOnce({
      store,
      notifier,
      portals: [portal],
      withPage: withPageStub,
      portalDepsFor: () => ({
        login: 'l',
        password: 'p',
        lastSubmittedValueFor: () => null,
        today: () => new Date(),
      }),
      now: new Date('2026-05-15T09:00:00Z'),
      force: false,
    });

    const row = store.getOrCreate('tgc1', '2026-05');
    expect(row.status).toBe('failed');
    expect(row.attempts).toBe(1);
    expect(row.lastErrorScreenshot).toBe('/data/s.png');
    expect(notifier.calls.failure).toHaveLength(1);
  });

  it('marks blocked after 5 failed attempts', async () => {
    const portal = makePortal({
      submit: vi.fn(async () => {
        throw new Error('TimeoutError');
      }),
    });
    const notifier = makeNotifier();

    // pre-seed 5 prior attempts
    store.getOrCreate('tgc1', '2026-05');
    for (let i = 0; i < 5; i++) store.markFailed('tgc1', '2026-05', 'e', null);

    await runOnce({
      store,
      notifier,
      portals: [portal],
      withPage: withPageStub,
      portalDepsFor: () => ({
        login: 'l',
        password: 'p',
        lastSubmittedValueFor: () => null,
        today: () => new Date(),
      }),
      now: new Date('2026-05-15T09:00:00Z'),
      force: false,
    });

    expect(portal.submit).not.toHaveBeenCalled();
    expect(store.getOrCreate('tgc1', '2026-05').status).toBe('blocked');
  });

  it('emits windowClosed on the last weekday if still not done, once only', async () => {
    const portal = makePortal({
      submit: vi.fn(async () => {
        throw new Error('e');
      }),
    });
    const notifier = makeNotifier();

    // 2026-05: last weekday in [15,21] is Thu 2026-05-21
    await runOnce({
      store,
      notifier,
      portals: [portal],
      withPage: withPageStub,
      portalDepsFor: () => ({
        login: 'l',
        password: 'p',
        lastSubmittedValueFor: () => null,
        today: () => new Date(),
      }),
      now: new Date('2026-05-21T09:00:00Z'),
      force: false,
    });
    await runOnce({
      store,
      notifier,
      portals: [portal],
      withPage: withPageStub,
      portalDepsFor: () => ({
        login: 'l',
        password: 'p',
        lastSubmittedValueFor: () => null,
        today: () => new Date(),
      }),
      now: new Date('2026-05-21T10:00:00Z'),
      force: false,
    });

    expect(notifier.calls.windowClosed).toHaveLength(1);
    expect(store.getOrCreate('tgc1', '2026-05').notifiedWindowClosed).toBe(true);
  });

  it('--force bypasses the targetDay gate and the done check', async () => {
    const portal = makePortal();
    const notifier = makeNotifier();

    store.getOrCreate('tgc1', '2026-05');
    store.markDone('tgc1', '2026-05', READINGS, { accountId: 'ACC', balanceText: 'x' });

    await runOnce({
      store,
      notifier,
      portals: [portal],
      withPage: withPageStub,
      portalDepsFor: () => ({
        login: 'l',
        password: 'p',
        lastSubmittedValueFor: () => null,
        today: () => new Date(),
      }),
      now: new Date('2026-05-10T09:00:00Z'), // before target
      force: true,
    });

    expect(portal.submit).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/runOnce.test.ts
```

Expected: FAIL (module not found).

- [ ] **Step 3: Write the orchestrator**

`services/meters/src/runOnce.ts`:

```ts
import type { Portal, PortalDeps } from './portals/types.ts';
import type { Notifier } from './notify/types.ts';
import type { SubmissionsStore } from './storage/types.ts';
import { currentPeriod } from './period.ts';
import { isInWindow, targetDay, lastWeekdayOfWindow } from './schedule.ts';
import { createLogger } from './logger.ts';
import type { Page } from 'playwright';

const log = createLogger('runOnce');

const MAX_ATTEMPTS = 5;

export interface BrowserSession {
  page: Page;
  screenshotOnFailure(label: string): Promise<string | null>;
}

export interface RunOnceDeps {
  store: SubmissionsStore;
  notifier: Notifier;
  portals: Portal[];
  withPage<T>(_: unknown, fn: (sess: BrowserSession) => Promise<T>): Promise<T>;
  portalDepsFor(portalName: string): PortalDeps;
  now: Date;
  force: boolean;
}

function ymdInMoscow(now: Date): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  return {
    year: Number(parts.find((p) => p.type === 'year')?.value),
    month: Number(parts.find((p) => p.type === 'month')?.value),
    day: Number(parts.find((p) => p.type === 'day')?.value),
  };
}

export async function runOnce(deps: RunOnceDeps): Promise<void> {
  const { year, month, day } = ymdInMoscow(deps.now);
  const period = currentPeriod(deps.now);
  const target = targetDay(year, month);
  const lastDay = lastWeekdayOfWindow(year, month);

  const beforeTarget = day < target;
  if (beforeTarget && !deps.force) {
    log.info({ today: day, target }, 'before targetDay, exiting');
    return;
  }
  if (!isInWindow(year, month, day) && !deps.force) {
    log.info({ today: day }, 'outside submission window, exiting');
    return;
  }

  for (const portal of deps.portals) {
    const row = deps.store.getOrCreate(portal.name, period);

    if (!deps.force && (row.status === 'done' || row.status === 'blocked')) {
      log.info({ portal: portal.name, status: row.status }, 'skipping, terminal status');
      continue;
    }

    if (!deps.force && row.attempts >= MAX_ATTEMPTS) {
      deps.store.markBlocked(portal.name, period);
      await deps.notifier.failure({
        portal: portal.name,
        period,
        attempt: row.attempts,
        maxAttempts: MAX_ATTEMPTS,
        error: 'Превышен лимит попыток — статус blocked',
        screenshotPath: row.lastErrorScreenshot,
      });
      continue;
    }

    try {
      const { values, info } = await deps.withPage({}, async (sess) => {
        try {
          const info = await portal.fetchAccountInfo(sess.page);
          const values = await portal.submit(sess.page, deps.portalDepsFor(portal.name));
          return { values, info };
        } catch (err) {
          const screenshotPath = await sess.screenshotOnFailure(`${portal.name}-${period}`);
          (err as Error & { screenshotPath?: string | null }).screenshotPath = screenshotPath;
          throw err;
        }
      });

      deps.store.markDone(
        portal.name,
        period,
        values,
        info ?? { accountId: '?', balanceText: '?' },
      );
      await deps.notifier.success({
        portal: portal.name,
        period,
        meterCount: values.length,
        info,
      });
    } catch (err) {
      const error = err as Error & { screenshotPath?: string | null };
      const screenshotPath = error.screenshotPath ?? null;
      deps.store.markFailed(portal.name, period, error.message, screenshotPath);
      const updated = deps.store.getOrCreate(portal.name, period);
      await deps.notifier.failure({
        portal: portal.name,
        period,
        attempt: updated.attempts,
        maxAttempts: MAX_ATTEMPTS,
        error: error.message,
        screenshotPath,
      });
    }
  }

  // Window-closed notification on the last weekday in [15,21]
  if (day === lastDay) {
    for (const portal of deps.portals) {
      const row = deps.store.getOrCreate(portal.name, period);
      if (row.status !== 'done' && !row.notifiedWindowClosed) {
        await deps.notifier.windowClosed({ portal: portal.name, period });
        deps.store.markWindowClosedNotified(portal.name, period);
      }
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/runOnce.test.ts
```

Expected: 7/7 pass. If a test fails, fix the orchestrator (not the test) — the tests pin the contract.

- [ ] **Step 5: Commit**

```bash
git add services/meters/src/runOnce.ts services/meters/tests/runOnce.test.ts
git commit -m "feat(meters): runOnce orchestration (gates, attempts, window-closed)"
```

---

## Task 14: CLI entry `index.ts`

**Files:**

- Create: `services/meters/src/index.ts`

- [ ] **Step 1: Write the CLI**

```ts
import { parseArgs } from 'node:util';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { runOnce } from './runOnce.ts';
import { openSubmissionsStore } from './storage/sqlite.ts';
import { TelegramNotifier } from './notify/telegram.ts';
import { Tgc1Portal } from './portals/tgc1.ts';
import { withBrowser } from './browser.ts';
import { createLogger } from './logger.ts';
import type { Portal } from './portals/types.ts';

const log = createLogger('index');

function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      portal: { type: 'string', default: 'tgc1' },
      force: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help) {
    console.log(`Usage: node src/index.ts [--portal=tgc1] [--force]

Options:
  --portal=NAME   Which portal to drive (default: tgc1).
  --force         Ignore the targetDay gate and the done/blocked row status.
                  Still respects the per-period attempts cap.
`);
    return;
  }

  const dataDir = env('METERS_DATA_DIR', '/app/data');
  await mkdir(dataDir, { recursive: true });

  const store = openSubmissionsStore(join(dataDir, 'meters.sqlite'));
  const notifier = new TelegramNotifier({
    token: env('TELEGRAM_BOT_TOKEN'),
    chatId: env('TELEGRAM_CHAT_ID'),
  });

  const tgc1 = new Tgc1Portal();
  const allPortals: Portal[] = [tgc1];
  const portals = allPortals.filter((p) => p.name === values.portal);
  if (portals.length === 0) {
    throw new Error(`Unknown portal: ${values.portal}`);
  }

  const proxyUrl = env('PROXY_URL', 'socks5://sing-box-ru:1080');
  const screenshotDir = join(dataDir, 'screenshots');
  const headed = env('METERS_HEADED', '0') === '1';

  try {
    await runOnce({
      store,
      notifier,
      portals,
      withPage: (_unused, fn) =>
        withBrowser({ proxyUrl, headed, screenshotDir }, (sess) =>
          fn({ page: sess.page, screenshotOnFailure: sess.screenshotOnFailure }),
        ),
      portalDepsFor: (name) => {
        if (name === 'tgc1') {
          return {
            login: env('TGC1_LOGIN'),
            password: env('TGC1_PASSWORD'),
            lastSubmittedValueFor: (meter) => store.lastSubmittedValueFor('tgc1', meter),
            today: () => new Date(),
          };
        }
        throw new Error(`No deps configured for portal: ${name}`);
      },
      now: new Date(),
      force: values.force,
    });
  } finally {
    store.close();
  }
}

main().catch((err) => {
  log.error({ err }, 'fatal');
  process.exit(1);
});
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Smoke-run with `--help` (no env vars needed)**

```bash
node src/index.ts --help
```

Expected: prints usage block.

- [ ] **Step 4: Commit**

```bash
git add services/meters/src/index.ts
git commit -m "feat(meters): CLI entry — argv, env wiring, portal selection"
```

---

## Task 15: Local dev — verify against a saved HTML page

**Files:**

- (Documentation only) — verify the dev loop works end-to-end against a local HTML
  page served via `python3 -m http.server`, with `PROXY_URL` pointed at a
  no-op direct proxy.

This task does not introduce code. It's a verification gate that proves the rest
of the codebase wires together correctly. Skip if running in CI / subagent
context with no shell access; the next task (Docker) will surface any
remaining issues.

- [ ] **Step 1: Start `sing-box-ru` locally (or skip and point to a known SOCKS5)**

```bash
docker compose -f deploy/docker-compose.yml up -d sing-box-ru
# OR: launch sing-box natively if Task 17 isn't merged yet — see Task 18
```

- [ ] **Step 2: Run with `--help` to confirm the binary starts**

```bash
cd services/meters
node --env-file=../../.env src/index.ts --help
```

- [ ] **Step 3: Document any surprises in CLAUDE.md (Task 23) — no commit here**

---

## Task 16: `meters-bot` Dockerfile

**Files:**

- Create: `services/meters/Dockerfile`
- Create: `services/meters/.dockerignore`

- [ ] **Step 1: Create `services/meters/.dockerignore`**

```
node_modules
data
screenshots
tests
*.log
.env
.env.*
.git
```

- [ ] **Step 2: Create `services/meters/Dockerfile`**

```dockerfile
# Playwright base image — comes with chromium + system fonts.
FROM mcr.microsoft.com/playwright:v1.50.0-jammy

WORKDIR /app

# Install deps with prebuilt better-sqlite3 binaries.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && \
    npm rebuild better-sqlite3

# Copy source (no build step — Node 24 strips TS at runtime).
COPY tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production \
    METERS_DATA_DIR=/app/data \
    PROXY_URL=socks5://sing-box-ru:1080

VOLUME ["/app/data"]

ENTRYPOINT ["node", "src/index.ts"]
```

> Why pin Playwright version: the npm package must match the chromium snapshot
> baked into the image. Bump them together.

- [ ] **Step 3: Build locally to sanity-check**

```bash
docker build -t ru-meters-bot:local services/meters
docker run --rm ru-meters-bot:local --help
```

Expected: usage text prints. (If the build fails, fix and re-try — do not skip
to the next task.)

- [ ] **Step 4: Commit**

```bash
git add services/meters/Dockerfile services/meters/.dockerignore
git commit -m "feat(meters): Dockerfile (playwright base + Node 24 ts-strip)"
```

---

## Task 17: `sing-box-ru` Dockerfile + entrypoint

**Files:**

- Create: `services/meters/sing-box/Dockerfile`
- Create: `services/meters/sing-box/entrypoint.mjs`

- [ ] **Step 1: Create `services/meters/sing-box/Dockerfile`**

```dockerfile
FROM ghcr.io/sagernet/sing-box:latest

RUN apk add --no-cache nodejs

# Bundle parseVlessUrl + entrypoint into the image. We copy the .ts file as-is;
# Node 24 strips types at runtime so we don't need a build step.
COPY entrypoint.mjs /entrypoint.mjs
COPY parseVlessUrl.ts /parseVlessUrl.ts

ENTRYPOINT ["/usr/bin/node", "/entrypoint.mjs"]
```

- [ ] **Step 2: Create `services/meters/sing-box/entrypoint.mjs`**

```js
#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

// parseVlessUrl is bundled as TS; with Node 24 we can import .ts directly.
const { parseVlessUrl } = await import('/parseVlessUrl.ts');

const url = process.env.RU_PROXY_URL;
if (!url) {
  console.error('RU_PROXY_URL env var is required');
  process.exit(1);
}

let config;
try {
  config = parseVlessUrl(url);
} catch (err) {
  console.error('Failed to parse RU_PROXY_URL:', err.message);
  process.exit(1);
}

const configPath = '/tmp/sb.json';
writeFileSync(configPath, JSON.stringify(config, null, 2));
console.log(`sing-box config written to ${configPath}`);

const child = spawn('/usr/local/bin/sing-box', ['run', '-c', configPath], {
  stdio: 'inherit',
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => child.kill(sig));
}
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
```

- [ ] **Step 3: Copy parseVlessUrl.ts into the sing-box build context at compose-build time**

This is handled by the compose `build.context` — the source file lives at
`services/meters/src/proxy/parseVlessUrl.ts` and gets copied via a tiny build
preparation step. To keep the Dockerfile self-contained, add a stage that pulls
the file directly:

Replace the `COPY parseVlessUrl.ts /parseVlessUrl.ts` line with:

```dockerfile
COPY ../src/proxy/parseVlessUrl.ts /parseVlessUrl.ts
```

…**but** Docker forbids `..` in COPY sources. The clean fix: set the compose
`build.context` to `services/meters` (one level up from `sing-box/`) and
reference both paths:

```dockerfile
COPY sing-box/entrypoint.mjs /entrypoint.mjs
COPY src/proxy/parseVlessUrl.ts /parseVlessUrl.ts
```

Update `services/meters/sing-box/Dockerfile` accordingly (it now expects to be
built with context `services/meters`, dockerfile `sing-box/Dockerfile`).

- [ ] **Step 4: Build the sing-box image locally**

```bash
docker build -t sing-box-ru:local -f services/meters/sing-box/Dockerfile services/meters
```

Expected: build succeeds. (Run is deferred until Task 18 wires compose.)

- [ ] **Step 5: Commit**

```bash
git add services/meters/sing-box
git commit -m "feat(meters): sing-box-ru image (sing-box + node entrypoint)"
```

---

## Task 18: Wire into `deploy/docker-compose.yml`

**Files:**

- Modify: `deploy/docker-compose.yml`

- [ ] **Step 1: Append the two services**

At the bottom of `deploy/docker-compose.yml`, before any top-level `networks:`/`volumes:` blocks (or at the end of `services:` if there are none), add:

```yaml
sing-box-ru:
  image: ghcr.io/maxmaxme/ru-meters-bot-sing-box:latest
  pull_policy: always
  build:
    context: ../services/meters
    dockerfile: sing-box/Dockerfile
  container_name: sing-box-ru
  restart: unless-stopped
  env_file:
    - ../.env
  ports:
    - '127.0.0.1:1080:1080' # localhost-only, for Mac dev loop
  healthcheck:
    test: ['CMD', 'sh', '-c', 'nc -z 127.0.0.1 1080']
    interval: 30s
    timeout: 5s
    retries: 3

meters-bot:
  image: ghcr.io/maxmaxme/ru-meters-bot:latest
  pull_policy: always
  build:
    context: ../services/meters
    dockerfile: Dockerfile
  # NB: no `restart` and no `container_name` — this service is invoked via
  # `docker compose run --rm meters-bot`, not `up`.
  depends_on:
    sing-box-ru:
      condition: service_started
  env_file:
    - ../.env
  environment:
    - PROXY_URL=socks5://sing-box-ru:1080
    - METERS_DATA_DIR=/app/data
    - TZ=Europe/Moscow
  volumes:
    - ../data/meters:/app/data
```

- [ ] **Step 2: Verify compose config parses**

```bash
docker compose -f deploy/docker-compose.yml config | grep -E 'sing-box-ru|meters-bot'
```

Expected: both services appear.

- [ ] **Step 3: Bring up the proxy locally and smoke-test the bot**

```bash
docker compose -f deploy/docker-compose.yml up -d --build sing-box-ru
docker compose -f deploy/docker-compose.yml run --rm meters-bot --help
```

Expected: sing-box-ru starts; meters-bot prints usage.

- [ ] **Step 4: Commit**

```bash
git add deploy/docker-compose.yml
git commit -m "feat(meters): wire sing-box-ru and meters-bot into deploy compose"
```

---

## Task 19: systemd timer + service units

**Files:**

- Create: `deploy/meters-bot.service`
- Create: `deploy/meters-bot.timer`

- [ ] **Step 1: Create `deploy/meters-bot.service`**

```ini
[Unit]
Description=Submit monthly meter readings via meters-bot container
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=/opt/voice-assistant/deploy
Environment=TZ=Europe/Moscow
ExecStart=/usr/bin/docker compose run --rm meters-bot
StandardOutput=journal
StandardError=journal
```

- [ ] **Step 2: Create `deploy/meters-bot.timer`**

```ini
[Unit]
Description=Run meters-bot Mon-Fri 12:00 MSK in the 15-21 window

[Timer]
OnCalendar=Mon..Fri *-*-15..21 12:00:00
Persistent=true
Unit=meters-bot.service

[Install]
WantedBy=timers.target
```

- [ ] **Step 3: Validate units locally (no install)**

```bash
systemd-analyze verify deploy/meters-bot.service deploy/meters-bot.timer
```

Expected: no errors. (If `systemd-analyze` is unavailable on the dev box, skip
this step — the Pi will validate on install.)

- [ ] **Step 4: Commit**

```bash
git add deploy/meters-bot.service deploy/meters-bot.timer
git commit -m "feat(meters): systemd timer + service units (Mon-Fri 12:00 MSK 15-21)"
```

---

## Task 20: GitHub Actions — add meters jobs to `ci.yml`

**Files:**

- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Append three jobs**

After the existing `format` job, before `build`, add:

```yaml
meters-typecheck:
  runs-on: ubuntu-latest
  defaults:
    run:
      working-directory: services/meters
  steps:
    - uses: actions/checkout@v6
    - uses: actions/setup-node@v4
      with:
        node-version: '24'
        cache: npm
        cache-dependency-path: services/meters/package-lock.json
    - run: npm ci
    - run: npm run typecheck

meters-test:
  runs-on: ubuntu-latest
  defaults:
    run:
      working-directory: services/meters
  steps:
    - uses: actions/checkout@v6
    - uses: actions/setup-node@v4
      with:
        node-version: '24'
        cache: npm
        cache-dependency-path: services/meters/package-lock.json
    - run: npm ci
    - run: npm test
```

Then add a second build job (mirroring the existing one):

```yaml
build-meters:
  needs: [meters-typecheck, meters-test, lint, format]
  if: github.event_name != 'pull_request'
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v6
    - uses: docker/setup-qemu-action@v3
      with:
        platforms: arm64
    - uses: docker/setup-buildx-action@v3
    - uses: docker/login-action@v3
      with:
        registry: ghcr.io
        username: ${{ github.actor }}
        password: ${{ secrets.GITHUB_TOKEN }}

    - name: Compute short SHA
      id: sha
      run: echo "short=$(git rev-parse --short HEAD)" >> "$GITHUB_OUTPUT"

    - name: Build meters-bot image
      uses: docker/build-push-action@v6
      with:
        context: services/meters
        file: services/meters/Dockerfile
        platforms: linux/arm64
        push: true
        tags: |
          ghcr.io/maxmaxme/ru-meters-bot:latest
          ghcr.io/maxmaxme/ru-meters-bot:sha-${{ steps.sha.outputs.short }}
        cache-from: type=gha
        cache-to: type=gha,mode=max

    - name: Build sing-box-ru image
      uses: docker/build-push-action@v6
      with:
        context: services/meters
        file: services/meters/sing-box/Dockerfile
        platforms: linux/arm64
        push: true
        tags: |
          ghcr.io/maxmaxme/ru-meters-bot-sing-box:latest
          ghcr.io/maxmaxme/ru-meters-bot-sing-box:sha-${{ steps.sha.outputs.short }}
        cache-from: type=gha
        cache-to: type=gha,mode=max
```

- [ ] **Step 2: Lint the workflow file**

If `act` or a YAML linter is available locally, run it. Otherwise rely on the
push triggering CI.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: typecheck/test meters package and build its two images"
```

---

## Task 21: Pre-commit hook coverage

**Files:**

- (Verify only, no edit) — root `package.json`'s `lint-staged` matches `*.{ts,js}`, which already covers `services/**`. ESLint flat config (`eslint.config.js`) at root needs `services/meters/tsconfig.json` referenced so it can typecheck-lint TS files.

- [ ] **Step 1: Inspect `eslint.config.js`**

```bash
cat eslint.config.js
```

If it references `tsconfig.json` (root) directly via `parserOptions.project`, ESLint will fail on `services/meters/**/*.ts` because the root tsconfig excludes it. Two ways to fix:

- **(a) Cheap:** ignore `services/**` from ESLint (`{ ignores: ['services/**'] }` in the flat config). Tests inside `services/meters/` still run via vitest; lint via prettier still applies.
- **(b) Proper:** add a second config block `{ files: ['services/**/*.ts'], languageOptions: { parserOptions: { project: 'services/meters/tsconfig.json' } } }`.

Pick **(b)** so the meters package gets the same ESLint treatment as va. If the current root config doesn't use `parserOptions.project` at all (i.e. it's syntax-only), no change is needed and you can skip to Step 3.

- [ ] **Step 2: Modify `eslint.config.js` accordingly**

If the project field is in use, append a block like:

```js
{
  files: ['services/meters/**/*.ts'],
  languageOptions: {
    parserOptions: {
      project: './services/meters/tsconfig.json',
      tsconfigRootDir: import.meta.dirname,
    },
  },
}
```

- [ ] **Step 3: Verify pre-commit works**

```bash
echo '' >> services/meters/src/index.ts
git add services/meters/src/index.ts
git status   # should show modification
# trigger lint-staged manually:
npx lint-staged
git restore --staged services/meters/src/index.ts
git checkout -- services/meters/src/index.ts
```

Expected: lint-staged runs prettier + eslint --fix without errors.

- [ ] **Step 4: Commit (only if eslint.config.js was modified)**

```bash
git add eslint.config.js
git commit -m "chore(meters): teach eslint about services/meters/ tsconfig"
```

If no change was needed, skip the commit.

---

## Task 22: First-time-Pi setup script

**Files:**

- Modify or create: `deploy/README.md`

- [ ] **Step 1: Append a "ru-meters-bot first-time setup" section**

````markdown
## ru-meters-bot — one-time Pi setup

After the first deploy that includes the meters-bot service, register the
systemd timer:

```bash
sudo cp /opt/voice-assistant/deploy/meters-bot.service /etc/systemd/system/
sudo cp /opt/voice-assistant/deploy/meters-bot.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now meters-bot.timer
systemctl list-timers meters-bot.timer   # confirm the next fire
```
````

Manual run (e.g. to test before the window opens):

```bash
cd /opt/voice-assistant/deploy
docker compose run --rm meters-bot --force
```

Logs:

```bash
journalctl -u meters-bot.service --since today
docker compose logs sing-box-ru
ls /opt/voice-assistant/data/meters/screenshots/
```

````

- [ ] **Step 2: Commit**

```bash
git add deploy/README.md
git commit -m "docs(meters): Pi-side install steps for the systemd timer"
````

---

## Task 23: Update `CLAUDE.md` and `README.md`

**Files:**

- Modify: `CLAUDE.md`
- Modify: `README.md`

- [ ] **Step 1: `CLAUDE.md` — add a section after "Architecture"**

```markdown
## services/meters/ — ru-meters-bot (sibling service)

A separate one-shot Node service that submits monthly ТГК-1 meter readings
through a RU SOCKS5 proxy (sing-box). Lives entirely under `services/meters/`
with its own `package.json`, `tsconfig.json`, `Dockerfile`, and vitest config.
The voice-assistant runtime does NOT import from it and is unaware it exists.

Scheduled by a host systemd timer (`deploy/meters-bot.timer`) — runs Mon-Fri
12:00 МСК on calendar days 15-21. In-code gate (`schedule.ts::targetDay`)
no-ops on dates before the first weekday ≥ 15. Manual: `docker compose run
--rm meters-bot --force`.

The two Docker images (`ru-meters-bot` and `ru-meters-bot-sing-box`) are built
by the same `ci.yml` workflow as voice-assistant.

Design + plan:

- `docs/superpowers/specs/2026-05-16-ru-meters-bot-design.md`
- `docs/superpowers/plans/2026-05-16-ru-meters-bot.md`
```

- [ ] **Step 2: `README.md` — append a one-paragraph mention to the Status section**

```markdown
- **ru-meters-bot** — sibling service under `services/meters/` that submits
  monthly ТГК-1 readings through a RU proxy. Independent image, independent
  schedule (systemd timer, Mon-Fri 12:00 МСК, days 15-21). Voice-assistant is
  not aware of it.
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs: mention ru-meters-bot in CLAUDE.md and README.md"
```

---

## Self-review (run before declaring the plan done)

- Spec coverage:
  - Goals (monthly submission, prev as value, Telegram notify, idempotency, isolation) → Tasks 2, 3, 8, 12, 13, 14
  - Non-goals (no real usage, no payment, no HA, no ПЭС) → all respected in scope
  - Architecture (services/meters/, sing-box-ru sidecar, host systemd timer) → Tasks 1, 17, 18, 19
  - Portal interface, ТГК-1 flow → Tasks 9, 10, 12, 13
  - sing-box URL parsing → Task 4 + entrypoint in Task 17
  - Storage schema → Tasks 5, 6
  - Notifications → Task 8
  - Tests (vitest, no bats, no live portal) → Tasks 2, 3, 4, 6, 8, 9, 13
  - Local dev (port 1080 on 127.0.0.1, METERS_HEADED) → Tasks 11, 14, 18
  - CI two images → Task 20
  - First-time Pi setup → Task 22
- Type consistency: `MeterReading`, `AccountInfo`, `SubmissionRow`, `Status`, `Portal`, `PortalDeps`, `Notifier` defined once (Tasks 5, 8, 10) and used consistently.
- No placeholders.
