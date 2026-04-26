# Reminders & Timers — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the agent two new capabilities — `add_reminder(when, text)` and `set_timer(seconds, label)`. Both persist to SQLite. While the agent process is running, due reminders/timers fire by sending a Telegram message to the user. We do **not** wake from sleep — if the Pi is off, the reminder waits in the DB until the process is back. The user explicitly accepted that trade-off.

**Architecture:**

1. **DB schema v2.** Two new tables: `reminders` and `timers`. Migration v2 added to `src/memory/migrations.ts`.
2. **Adapter pattern preserved.** `RemindersAdapter` + `TimersAdapter` interfaces in `src/memory/types.ts`, SQLite implementations next to the existing `SqliteProfileMemory`. Each implementation accepts a shared `Database` instance so they run on one DB file (one connection, no duplicates).
3. **Memory facade.** New `MemoryStore` aggregates `profile` + `reminders` + `timers` so the rest of the code passes around one object.
4. **Scheduler.** A new module `src/scheduling/scheduler.ts` ticks every 15 s, queries due rows, fires a callback (the runner wires it to Telegram). One scheduler per process; survives runner crashes via a `try/catch` per tick.
5. **Tools.** New OpenAI function tools: `add_reminder`, `list_reminders`, `cancel_reminder`, `set_timer`, `list_timers`, `cancel_timer`. Plumbed through `OpenAiAgent` next to memory tools.
6. **Wiring.** `unified.ts` constructs the scheduler, hands it the Telegram sender, starts it as another concurrent task in `dispatch`. Stops on shutdown.

**Tech Stack:** Node 24 native TS stripping, `better-sqlite3` (already a dep), Vitest with `vi.useFakeTimers()`. No new npm deps.

**Prerequisites:** Plan `2026-04-26-unify-cli-entrypoints.md` AND `2026-04-26-telegram-inbound.md` are merged. (Telegram is the only delivery channel for fired reminders.)

---

## File Structure

```
src/memory/
├── types.ts                       # MODIFIED: + RemindersAdapter, TimersAdapter, MemoryStore, types
├── migrations.ts                  # MODIFIED: + v2 SQL
├── migrate.ts                     # UNCHANGED
├── sqliteProfileMemory.ts         # MODIFIED: accept shared Database; expose .db
├── sqliteReminders.ts             # NEW
├── sqliteTimers.ts                # NEW
└── memoryStore.ts                 # NEW: facade

src/scheduling/
├── scheduler.ts                   # NEW: 15s tick loop
└── types.ts                       # NEW: DueItem union

src/agent/
├── reminderTools.ts               # NEW: add/list/cancel reminder tools
├── timerTools.ts                  # NEW: set/list/cancel timer tools
└── openaiAgent.ts                 # MODIFIED: register new tools, route in switch

src/cli/
├── shared.ts                      # MODIFIED: build MemoryStore + Scheduler
└── unified.ts                     # MODIFIED: dispatch scheduler

tests/memory/
├── sqliteReminders.test.ts        # NEW
├── sqliteTimers.test.ts           # NEW
└── migrate.test.ts                # MODIFIED: assert v2 tables

tests/scheduling/
└── scheduler.test.ts              # NEW

tests/agent/
├── reminderTools.test.ts          # NEW
└── timerTools.test.ts             # NEW
```

---

## Out-of-scope (do NOT do here)

- ❌ Cron / recurring reminders. One-shot only. (`repeat_pattern` column in the schema is reserved but unused; a follow-up plan turns it on.)
- ❌ Reminder snooze. The fired-callback either succeeds (mark fired) or fails (will retry next tick).
- ❌ Multi-user separation. Single-user setup; no `user_id` column.
- ❌ Natural-language date parsing in code. The LLM resolves "завтра в 9 утра" to an ISO timestamp via the tool's `when` param.
- ❌ Cross-process scheduler. One process owns the tick — no leader election.

---

## Task 1: Schema v2 — migration SQL

**Files:**

- Modify: `src/memory/migrations.ts`
- Modify: `tests/memory/migrate.test.ts`

- [ ] **Step 1: Add a failing test**

Edit `tests/memory/migrate.test.ts` (whatever its current shape is) and append:

```typescript
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/memory/migrate.ts';

describe('migrations v2', () => {
  it('creates reminders and timers tables', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain('reminders');
    expect(names).toContain('timers');
    expect(names).toContain('schema_version');
    db.close();
  });

  it('records version 2', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const max = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number };
    expect(max.v).toBeGreaterThanOrEqual(2);
    db.close();
  });

  it('reminders has expected columns', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const cols = db.prepare('PRAGMA table_info(reminders)').all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    for (const c of [
      'id',
      'text',
      'fire_at',
      'status',
      'created_at',
      'fired_at',
      'repeat_pattern',
    ]) {
      expect(names.has(c)).toBe(true);
    }
    db.close();
  });

  it('timers has expected columns', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const cols = db.prepare('PRAGMA table_info(timers)').all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    for (const c of ['id', 'label', 'fire_at', 'duration_ms', 'status', 'created_at', 'fired_at']) {
      expect(names.has(c)).toBe(true);
    }
    db.close();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/memory/migrate.test.ts`
Expected: FAIL — tables don't exist.

- [ ] **Step 3: Append v2 to `src/memory/migrations.ts`**

```typescript
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY
      );
      CREATE TABLE IF NOT EXISTS profile (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO schema_version (version) VALUES (1);
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS reminders (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        text           TEXT NOT NULL,
        fire_at        INTEGER NOT NULL,
        repeat_pattern TEXT,
        status         TEXT NOT NULL DEFAULT 'pending',
        created_at     INTEGER NOT NULL,
        fired_at       INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_reminders_due
        ON reminders(fire_at) WHERE status = 'pending';

      CREATE TABLE IF NOT EXISTS timers (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        label       TEXT NOT NULL,
        fire_at     INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        status      TEXT NOT NULL DEFAULT 'active',
        created_at  INTEGER NOT NULL,
        fired_at    INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_timers_due
        ON timers(fire_at) WHERE status = 'active';

      INSERT OR IGNORE INTO schema_version (version) VALUES (2);
    `,
  },
];
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/memory/migrate.test.ts`
Expected: PASS — all migration tests green.

- [ ] **Step 5: Commit**

```bash
git add src/memory/migrations.ts tests/memory/migrate.test.ts
git commit -m "feat(memory): schema v2 — reminders + timers tables"
```

---

## Task 2: Refactor `SqliteProfileMemory` to accept a shared DB

So `SqliteReminders` and `SqliteTimers` can run on the same connection.

**Files:**

- Modify: `src/memory/sqliteProfileMemory.ts`
- Modify: `tests/memory/sqliteProfileMemory.test.ts`

- [ ] **Step 1: Update tests for the new constructor option**

Add to `tests/memory/sqliteProfileMemory.test.ts`:

```typescript
it('accepts an externally-owned Database', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  const m = new SqliteProfileMemory({ db });
  m.remember('x', 1);
  expect(m.recall()).toEqual({ x: 1 });
  // close() does not close the externally-owned db
  m.close();
  expect(() => db.prepare('SELECT 1').get()).not.toThrow();
  db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/memory/sqliteProfileMemory.test.ts -t 'externally-owned'`
Expected: FAIL — `db` option not supported.

- [ ] **Step 3: Modify `src/memory/sqliteProfileMemory.ts`**

```typescript
import Database from 'better-sqlite3';
import { runMigrations } from './migrate.ts';
import type { MemoryAdapter, ProfileFacts } from './types.ts';

export type SqliteProfileMemoryOptions =
  | { dbPath: string; db?: undefined }
  | { db: Database.Database; dbPath?: undefined };

export class SqliteProfileMemory implements MemoryAdapter {
  private readonly db: Database.Database;
  private readonly ownsDb: boolean;

  constructor(opts: SqliteProfileMemoryOptions) {
    if (opts.db) {
      this.db = opts.db;
      this.ownsDb = false;
    } else {
      this.db = new Database(opts.dbPath);
      this.db.pragma('journal_mode = WAL');
      this.ownsDb = true;
    }
    runMigrations(this.db);
  }

  remember(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO profile (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(value), Date.now());
  }

  recall(key?: string): ProfileFacts {
    if (key !== undefined) {
      const row = this.db.prepare('SELECT value FROM profile WHERE key = ?').get(key) as
        | { value: string }
        | undefined;
      if (!row) return {};
      return { [key]: JSON.parse(row.value) };
    }
    const rows = this.db.prepare('SELECT key, value FROM profile').all() as Array<{
      key: string;
      value: string;
    }>;
    const out: ProfileFacts = {};
    for (const r of rows) out[r.key] = JSON.parse(r.value);
    return out;
  }

  forget(key: string): void {
    this.db.prepare('DELETE FROM profile WHERE key = ?').run(key);
  }

  close(): void {
    if (this.ownsDb) this.db.close();
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/memory/sqliteProfileMemory.test.ts`
Expected: PASS — old tests still green, new test green.

- [ ] **Step 5: Commit**

```bash
git add src/memory/sqliteProfileMemory.ts tests/memory/sqliteProfileMemory.test.ts
git commit -m "refactor(memory): SqliteProfileMemory accepts externally-owned db"
```

---

## Task 3: Reminders adapter

**Files:**

- Modify: `src/memory/types.ts`
- Create: `src/memory/sqliteReminders.ts`
- Create: `tests/memory/sqliteReminders.test.ts`

- [ ] **Step 1: Add types**

Append to `src/memory/types.ts`:

```typescript
export interface Reminder {
  id: number;
  text: string;
  fireAt: number;
  status: 'pending' | 'fired' | 'cancelled';
  createdAt: number;
  firedAt: number | null;
}

export interface NewReminder {
  text: string;
  fireAt: number;
}

export interface RemindersAdapter {
  add(input: NewReminder): Reminder;
  listPending(): Reminder[];
  listDue(now: number): Reminder[];
  markFired(id: number, firedAt: number): void;
  cancel(id: number): boolean;
  get(id: number): Reminder | null;
}
```

- [ ] **Step 2: Write the failing tests**

Create `tests/memory/sqliteReminders.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/memory/migrate.ts';
import { SqliteReminders } from '../../src/memory/sqliteReminders.ts';

describe('SqliteReminders', () => {
  let db: Database.Database;
  let r: SqliteReminders;
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    r = new SqliteReminders(db);
  });
  afterEach(() => db.close());

  it('starts empty', () => {
    expect(r.listPending()).toEqual([]);
  });

  it('add returns the row with assigned id', () => {
    const out = r.add({ text: 'call mom', fireAt: 1000 });
    expect(out.id).toBeGreaterThan(0);
    expect(out.text).toBe('call mom');
    expect(out.fireAt).toBe(1000);
    expect(out.status).toBe('pending');
    expect(out.firedAt).toBeNull();
  });

  it('listPending returns only pending in fire_at order', () => {
    r.add({ text: 'b', fireAt: 200 });
    r.add({ text: 'a', fireAt: 100 });
    const fired = r.add({ text: 'c', fireAt: 50 });
    r.markFired(fired.id, 50);
    const pending = r.listPending();
    expect(pending.map((p) => p.text)).toEqual(['a', 'b']);
  });

  it('listDue returns only items with fire_at <= now', () => {
    r.add({ text: 'past', fireAt: 100 });
    r.add({ text: 'future', fireAt: 1000 });
    expect(r.listDue(500).map((p) => p.text)).toEqual(['past']);
  });

  it('markFired flips status and stamps fired_at', () => {
    const x = r.add({ text: 'x', fireAt: 100 });
    r.markFired(x.id, 200);
    const re = r.get(x.id);
    expect(re?.status).toBe('fired');
    expect(re?.firedAt).toBe(200);
  });

  it('cancel returns true on pending and false on missing/already-fired', () => {
    const x = r.add({ text: 'x', fireAt: 100 });
    expect(r.cancel(x.id)).toBe(true);
    expect(r.cancel(x.id)).toBe(false); // already cancelled
    expect(r.cancel(99999)).toBe(false);
  });

  it('cancelled reminders are not in listPending', () => {
    const x = r.add({ text: 'x', fireAt: 100 });
    r.cancel(x.id);
    expect(r.listPending()).toEqual([]);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/memory/sqliteReminders.test.ts`
Expected: FAIL.

- [ ] **Step 4: Create `src/memory/sqliteReminders.ts`**

```typescript
import type Database from 'better-sqlite3';
import type { NewReminder, Reminder, RemindersAdapter } from './types.ts';

interface Row {
  id: number;
  text: string;
  fire_at: number;
  status: Reminder['status'];
  created_at: number;
  fired_at: number | null;
}

const toReminder = (r: Row): Reminder => ({
  id: r.id,
  text: r.text,
  fireAt: r.fire_at,
  status: r.status,
  createdAt: r.created_at,
  firedAt: r.fired_at,
});

export class SqliteReminders implements RemindersAdapter {
  constructor(private readonly db: Database.Database) {}

  add(input: NewReminder): Reminder {
    const now = Date.now();
    const result = this.db
      .prepare(
        `INSERT INTO reminders (text, fire_at, status, created_at)
         VALUES (?, ?, 'pending', ?)`,
      )
      .run(input.text, input.fireAt, now);
    const id = Number(result.lastInsertRowid);
    return this.get(id)!;
  }

  listPending(): Reminder[] {
    const rows = this.db
      .prepare(`SELECT * FROM reminders WHERE status = 'pending' ORDER BY fire_at ASC`)
      .all() as Row[];
    return rows.map(toReminder);
  }

  listDue(now: number): Reminder[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM reminders
         WHERE status = 'pending' AND fire_at <= ?
         ORDER BY fire_at ASC`,
      )
      .all(now) as Row[];
    return rows.map(toReminder);
  }

  markFired(id: number, firedAt: number): void {
    this.db
      .prepare(
        `UPDATE reminders SET status = 'fired', fired_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(firedAt, id);
  }

  cancel(id: number): boolean {
    const res = this.db
      .prepare(`UPDATE reminders SET status = 'cancelled' WHERE id = ? AND status = 'pending'`)
      .run(id);
    return res.changes > 0;
  }

  get(id: number): Reminder | null {
    const row = this.db.prepare(`SELECT * FROM reminders WHERE id = ?`).get(id) as Row | undefined;
    return row ? toReminder(row) : null;
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/memory/sqliteReminders.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 6: Commit**

```bash
git add src/memory/types.ts src/memory/sqliteReminders.ts tests/memory/sqliteReminders.test.ts
git commit -m "feat(memory): SqliteReminders adapter"
```

---

## Task 4: Timers adapter

**Files:**

- Modify: `src/memory/types.ts`
- Create: `src/memory/sqliteTimers.ts`
- Create: `tests/memory/sqliteTimers.test.ts`

- [ ] **Step 1: Add types**

Append to `src/memory/types.ts`:

```typescript
export interface Timer {
  id: number;
  label: string;
  fireAt: number;
  durationMs: number;
  status: 'active' | 'fired' | 'cancelled';
  createdAt: number;
  firedAt: number | null;
}

export interface NewTimer {
  label: string;
  fireAt: number;
  durationMs: number;
}

export interface TimersAdapter {
  add(input: NewTimer): Timer;
  listActive(): Timer[];
  listDue(now: number): Timer[];
  markFired(id: number, firedAt: number): void;
  cancel(id: number): boolean;
  get(id: number): Timer | null;
}
```

- [ ] **Step 2: Write the failing tests**

Create `tests/memory/sqliteTimers.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/memory/migrate.ts';
import { SqliteTimers } from '../../src/memory/sqliteTimers.ts';

describe('SqliteTimers', () => {
  let db: Database.Database;
  let t: SqliteTimers;
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    t = new SqliteTimers(db);
  });
  afterEach(() => db.close());

  it('starts empty', () => {
    expect(t.listActive()).toEqual([]);
  });

  it('add returns the row', () => {
    const x = t.add({ label: 'pasta', fireAt: 1000, durationMs: 500 });
    expect(x.id).toBeGreaterThan(0);
    expect(x.label).toBe('pasta');
    expect(x.durationMs).toBe(500);
    expect(x.status).toBe('active');
  });

  it('listDue returns only items at-or-past fireAt', () => {
    t.add({ label: 'a', fireAt: 100, durationMs: 1 });
    t.add({ label: 'b', fireAt: 1000, durationMs: 1 });
    expect(t.listDue(500).map((x) => x.label)).toEqual(['a']);
  });

  it('markFired updates status', () => {
    const x = t.add({ label: 'x', fireAt: 100, durationMs: 1 });
    t.markFired(x.id, 150);
    const r = t.get(x.id);
    expect(r?.status).toBe('fired');
    expect(r?.firedAt).toBe(150);
  });

  it('cancel returns true once', () => {
    const x = t.add({ label: 'x', fireAt: 100, durationMs: 1 });
    expect(t.cancel(x.id)).toBe(true);
    expect(t.cancel(x.id)).toBe(false);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/memory/sqliteTimers.test.ts`
Expected: FAIL.

- [ ] **Step 4: Create `src/memory/sqliteTimers.ts`**

```typescript
import type Database from 'better-sqlite3';
import type { NewTimer, Timer, TimersAdapter } from './types.ts';

interface Row {
  id: number;
  label: string;
  fire_at: number;
  duration_ms: number;
  status: Timer['status'];
  created_at: number;
  fired_at: number | null;
}

const toTimer = (r: Row): Timer => ({
  id: r.id,
  label: r.label,
  fireAt: r.fire_at,
  durationMs: r.duration_ms,
  status: r.status,
  createdAt: r.created_at,
  firedAt: r.fired_at,
});

export class SqliteTimers implements TimersAdapter {
  constructor(private readonly db: Database.Database) {}

  add(input: NewTimer): Timer {
    const now = Date.now();
    const result = this.db
      .prepare(
        `INSERT INTO timers (label, fire_at, duration_ms, status, created_at)
         VALUES (?, ?, ?, 'active', ?)`,
      )
      .run(input.label, input.fireAt, input.durationMs, now);
    return this.get(Number(result.lastInsertRowid))!;
  }

  listActive(): Timer[] {
    const rows = this.db
      .prepare(`SELECT * FROM timers WHERE status = 'active' ORDER BY fire_at ASC`)
      .all() as Row[];
    return rows.map(toTimer);
  }

  listDue(now: number): Timer[] {
    const rows = this.db
      .prepare(`SELECT * FROM timers WHERE status = 'active' AND fire_at <= ? ORDER BY fire_at ASC`)
      .all(now) as Row[];
    return rows.map(toTimer);
  }

  markFired(id: number, firedAt: number): void {
    this.db
      .prepare(
        `UPDATE timers SET status = 'fired', fired_at = ?
         WHERE id = ? AND status = 'active'`,
      )
      .run(firedAt, id);
  }

  cancel(id: number): boolean {
    const res = this.db
      .prepare(`UPDATE timers SET status = 'cancelled' WHERE id = ? AND status = 'active'`)
      .run(id);
    return res.changes > 0;
  }

  get(id: number): Timer | null {
    const row = this.db.prepare(`SELECT * FROM timers WHERE id = ?`).get(id) as Row | undefined;
    return row ? toTimer(row) : null;
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/memory/sqliteTimers.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 6: Commit**

```bash
git add src/memory/types.ts src/memory/sqliteTimers.ts tests/memory/sqliteTimers.test.ts
git commit -m "feat(memory): SqliteTimers adapter"
```

---

## Task 5: `MemoryStore` facade

A thin wrapper that owns one DB connection and exposes the three adapters. Replaces the bare `SqliteProfileMemory` constructed in `src/cli/shared.ts`.

**Files:**

- Modify: `src/memory/types.ts` (add `MemoryStore` type)
- Create: `src/memory/memoryStore.ts`
- Create: `tests/memory/memoryStore.test.ts`

- [ ] **Step 1: Define `MemoryStore`**

Append to `src/memory/types.ts`:

```typescript
export interface MemoryStore {
  profile: MemoryAdapter;
  reminders: RemindersAdapter;
  timers: TimersAdapter;
  close(): void;
}
```

- [ ] **Step 2: Write the failing test**

Create `tests/memory/memoryStore.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openMemoryStore } from '../../src/memory/memoryStore.ts';

describe('openMemoryStore', () => {
  let dbPath: string;
  beforeEach(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memstore-'));
    dbPath = path.join(dir, 'a.db');
  });

  it('exposes profile, reminders, timers on one DB', () => {
    const m = openMemoryStore(dbPath);
    m.profile.remember('name', 'Maxim');
    m.reminders.add({ text: 'r', fireAt: 1 });
    m.timers.add({ label: 't', fireAt: 1, durationMs: 1 });
    expect(m.profile.recall('name')).toEqual({ name: 'Maxim' });
    expect(m.reminders.listPending()[0].text).toBe('r');
    expect(m.timers.listActive()[0].label).toBe('t');
    m.close();
  });

  it('survives reopen — data persisted', () => {
    {
      const m = openMemoryStore(dbPath);
      m.profile.remember('x', 1);
      m.reminders.add({ text: 'persist', fireAt: 5 });
      m.close();
    }
    const m2 = openMemoryStore(dbPath);
    expect(m2.profile.recall('x')).toEqual({ x: 1 });
    expect(m2.reminders.listPending()[0].text).toBe('persist');
    m2.close();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/memory/memoryStore.test.ts`
Expected: FAIL.

- [ ] **Step 4: Create `src/memory/memoryStore.ts`**

```typescript
import Database from 'better-sqlite3';
import { runMigrations } from './migrate.ts';
import { SqliteProfileMemory } from './sqliteProfileMemory.ts';
import { SqliteReminders } from './sqliteReminders.ts';
import { SqliteTimers } from './sqliteTimers.ts';
import type { MemoryStore } from './types.ts';

export function openMemoryStore(dbPath: string): MemoryStore {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  runMigrations(db);
  const profile = new SqliteProfileMemory({ db });
  const reminders = new SqliteReminders(db);
  const timers = new SqliteTimers(db);
  return {
    profile,
    reminders,
    timers,
    close() {
      db.close();
    },
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/memory/memoryStore.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/memory/types.ts src/memory/memoryStore.ts tests/memory/memoryStore.test.ts
git commit -m "feat(memory): MemoryStore facade — one DB, three adapters"
```

---

## Task 6: Reminder tools for the agent

**Files:**

- Create: `src/agent/reminderTools.ts`
- Create: `tests/agent/reminderTools.test.ts`

The LLM resolves natural-language times like "завтра в 9 утра" itself — it gets `fire_at` as a Unix-ms integer. We pass the current time hint via `additionalProperties: false`-stripped tool; the system prompt addendum tells it where to look for "now" (we add it in Task 8).

- [ ] **Step 1: Write the failing tests**

Create `tests/agent/reminderTools.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import {
  REMINDER_TOOL_NAMES,
  buildReminderTools,
  executeReminderTool,
} from '../../src/agent/reminderTools.ts';
import type { RemindersAdapter, Reminder } from '../../src/memory/types.ts';

function memReminders(): RemindersAdapter {
  let id = 0;
  const items: Reminder[] = [];
  return {
    add: ({ text, fireAt }) => {
      const r: Reminder = {
        id: ++id,
        text,
        fireAt,
        status: 'pending',
        createdAt: Date.now(),
        firedAt: null,
      };
      items.push(r);
      return r;
    },
    listPending: () => items.filter((i) => i.status === 'pending'),
    listDue: (now) => items.filter((i) => i.status === 'pending' && i.fireAt <= now),
    markFired: (id, at) => {
      const r = items.find((x) => x.id === id);
      if (r) {
        r.status = 'fired';
        r.firedAt = at;
      }
    },
    cancel: (id) => {
      const r = items.find((x) => x.id === id && x.status === 'pending');
      if (!r) return false;
      r.status = 'cancelled';
      return true;
    },
    get: (id) => items.find((x) => x.id === id) ?? null,
  };
}

describe('reminderTools', () => {
  it('exposes 3 tool names', () => {
    expect(REMINDER_TOOL_NAMES).toEqual(
      new Set(['add_reminder', 'list_reminders', 'cancel_reminder']),
    );
  });

  it('build returns tool definitions with required params', () => {
    const tools = buildReminderTools();
    const add = tools.find((t) => t.name === 'add_reminder')!;
    expect(add.parameters).toMatchObject({
      required: expect.arrayContaining(['text', 'fire_at']),
    });
  });

  it('add_reminder writes to the adapter and returns the id', () => {
    const r = memReminders();
    const out = executeReminderTool(r, 'add_reminder', { text: 'X', fire_at: 1000 }) as any;
    expect(out.id).toBe(1);
    expect(r.listPending()).toHaveLength(1);
  });

  it('add_reminder rejects fire_at in the past with a clear error', () => {
    const r = memReminders();
    expect(() =>
      executeReminderTool(r, 'add_reminder', { text: 'X', fire_at: Date.now() - 60_000 }),
    ).toThrow(/past/i);
  });

  it('list_reminders returns pending only', () => {
    const r = memReminders();
    r.add({ text: 'a', fireAt: 100 });
    const fired = r.add({ text: 'b', fireAt: 50 });
    r.markFired(fired.id, 50);
    const out = executeReminderTool(r, 'list_reminders', {}) as any[];
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe('a');
  });

  it('cancel_reminder returns ok:true on success and ok:false on missing', () => {
    const r = memReminders();
    const x = r.add({ text: 'a', fireAt: 100 });
    expect(executeReminderTool(r, 'cancel_reminder', { id: x.id })).toEqual({ ok: true });
    expect(executeReminderTool(r, 'cancel_reminder', { id: 99999 })).toEqual({ ok: false });
  });

  it('throws for unknown tool name', () => {
    const r = memReminders();
    expect(() => executeReminderTool(r, 'whatever', {})).toThrow(/unknown/i);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/agent/reminderTools.test.ts`
Expected: FAIL.

- [ ] **Step 3: Create `src/agent/reminderTools.ts`**

```typescript
import type { RemindersAdapter } from '../memory/types.ts';
import type { OpenAiFunctionTool } from './toolBridge.ts';

export const REMINDER_TOOL_NAMES = new Set(['add_reminder', 'list_reminders', 'cancel_reminder']);

export function buildReminderTools(): OpenAiFunctionTool[] {
  return [
    {
      type: 'function',
      name: 'add_reminder',
      description:
        'Schedule a one-shot reminder. The user gets a Telegram message with `text` at `fire_at`. ' +
        'Resolve user phrasing like "tomorrow at 9am" / "завтра в 9 утра" yourself based on the current time. ' +
        'Returns the new reminder id.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'What to remind the user about. Plain text.' },
          fire_at: {
            type: 'integer',
            description: 'When to fire, as Unix ms (UTC). Must be in the future.',
          },
        },
        required: ['text', 'fire_at'],
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'list_reminders',
      description: 'List pending reminders sorted by fire_at ascending.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'cancel_reminder',
      description:
        'Cancel a pending reminder by id. Returns {ok: true} if it was pending, else {ok: false}.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'integer' } },
        required: ['id'],
        additionalProperties: false,
      },
    },
  ];
}

export function executeReminderTool(
  reminders: RemindersAdapter,
  name: string,
  args: Record<string, unknown>,
): unknown {
  switch (name) {
    case 'add_reminder': {
      const text = String(args.text ?? '').trim();
      const fireAt = Number(args.fire_at);
      if (!text) throw new Error('add_reminder: text is required');
      if (!Number.isFinite(fireAt)) throw new Error('add_reminder: fire_at must be a number');
      if (fireAt <= Date.now()) throw new Error('add_reminder: fire_at is in the past');
      const r = reminders.add({ text, fireAt });
      return { id: r.id, fire_at: r.fireAt, text: r.text };
    }
    case 'list_reminders':
      return reminders.listPending().map((r) => ({ id: r.id, text: r.text, fire_at: r.fireAt }));
    case 'cancel_reminder': {
      const id = Number(args.id);
      if (!Number.isFinite(id)) throw new Error('cancel_reminder: id must be a number');
      return { ok: reminders.cancel(id) };
    }
    default:
      throw new Error(`Unknown reminder tool: ${name}`);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/agent/reminderTools.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/agent/reminderTools.ts tests/agent/reminderTools.test.ts
git commit -m "feat(agent): add_reminder/list_reminders/cancel_reminder tools"
```

---

## Task 7: Timer tools

**Files:**

- Create: `src/agent/timerTools.ts`
- Create: `tests/agent/timerTools.test.ts`

Same shape as reminders. Timers take `seconds` instead of an absolute time.

- [ ] **Step 1: Write the failing tests**

Create `tests/agent/timerTools.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { TIMER_TOOL_NAMES, buildTimerTools, executeTimerTool } from '../../src/agent/timerTools.ts';
import type { TimersAdapter, Timer } from '../../src/memory/types.ts';

function memTimers(): TimersAdapter {
  let id = 0;
  const items: Timer[] = [];
  return {
    add: ({ label, fireAt, durationMs }) => {
      const t: Timer = {
        id: ++id,
        label,
        fireAt,
        durationMs,
        status: 'active',
        createdAt: Date.now(),
        firedAt: null,
      };
      items.push(t);
      return t;
    },
    listActive: () => items.filter((i) => i.status === 'active'),
    listDue: (now) => items.filter((i) => i.status === 'active' && i.fireAt <= now),
    markFired: (id, at) => {
      const t = items.find((x) => x.id === id);
      if (t) {
        t.status = 'fired';
        t.firedAt = at;
      }
    },
    cancel: (id) => {
      const t = items.find((x) => x.id === id && x.status === 'active');
      if (!t) return false;
      t.status = 'cancelled';
      return true;
    },
    get: (id) => items.find((x) => x.id === id) ?? null,
  };
}

describe('timerTools', () => {
  it('exposes 3 tool names', () => {
    expect(TIMER_TOOL_NAMES).toEqual(new Set(['set_timer', 'list_timers', 'cancel_timer']));
  });

  it('set_timer creates a timer firing at now+seconds*1000', () => {
    const t = memTimers();
    const before = Date.now();
    const out = executeTimerTool(t, 'set_timer', { label: 'pasta', seconds: 60 }) as any;
    expect(out.id).toBe(1);
    expect(out.fire_at).toBeGreaterThanOrEqual(before + 60_000);
    expect(out.fire_at).toBeLessThanOrEqual(Date.now() + 60_000 + 100);
    expect(t.listActive()[0].label).toBe('pasta');
  });

  it('set_timer rejects non-positive seconds', () => {
    const t = memTimers();
    expect(() => executeTimerTool(t, 'set_timer', { label: 'x', seconds: 0 })).toThrow();
    expect(() => executeTimerTool(t, 'set_timer', { label: 'x', seconds: -3 })).toThrow();
  });

  it('list_timers returns active', () => {
    const t = memTimers();
    t.add({ label: 'a', fireAt: 100, durationMs: 100 });
    expect((executeTimerTool(t, 'list_timers', {}) as any[]).length).toBe(1);
  });

  it('cancel_timer round-trip', () => {
    const t = memTimers();
    const x = t.add({ label: 'a', fireAt: 100, durationMs: 100 });
    expect(executeTimerTool(t, 'cancel_timer', { id: x.id })).toEqual({ ok: true });
    expect(executeTimerTool(t, 'cancel_timer', { id: x.id })).toEqual({ ok: false });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/agent/timerTools.test.ts`
Expected: FAIL.

- [ ] **Step 3: Create `src/agent/timerTools.ts`**

```typescript
import type { TimersAdapter } from '../memory/types.ts';
import type { OpenAiFunctionTool } from './toolBridge.ts';

export const TIMER_TOOL_NAMES = new Set(['set_timer', 'list_timers', 'cancel_timer']);

export function buildTimerTools(): OpenAiFunctionTool[] {
  return [
    {
      type: 'function',
      name: 'set_timer',
      description:
        'Start a one-shot countdown timer. After `seconds`, the user gets a Telegram message saying the timer is up. ' +
        'Use for cooking timers, "remind me in 10 minutes", quick pings.',
      parameters: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'Short label, e.g. "pasta", "coffee".' },
          seconds: { type: 'integer', description: 'Countdown in whole seconds. > 0.' },
        },
        required: ['label', 'seconds'],
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'list_timers',
      description: 'List active timers.',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    },
    {
      type: 'function',
      name: 'cancel_timer',
      description: 'Cancel an active timer by id.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'integer' } },
        required: ['id'],
        additionalProperties: false,
      },
    },
  ];
}

export function executeTimerTool(
  timers: TimersAdapter,
  name: string,
  args: Record<string, unknown>,
): unknown {
  switch (name) {
    case 'set_timer': {
      const label = String(args.label ?? '').trim();
      const seconds = Number(args.seconds);
      if (!label) throw new Error('set_timer: label is required');
      if (!Number.isFinite(seconds) || seconds <= 0) {
        throw new Error('set_timer: seconds must be a positive number');
      }
      const durationMs = Math.round(seconds * 1000);
      const fireAt = Date.now() + durationMs;
      const t = timers.add({ label, fireAt, durationMs });
      return { id: t.id, label: t.label, fire_at: t.fireAt, duration_ms: t.durationMs };
    }
    case 'list_timers':
      return timers.listActive().map((t) => ({
        id: t.id,
        label: t.label,
        fire_at: t.fireAt,
        duration_ms: t.durationMs,
      }));
    case 'cancel_timer': {
      const id = Number(args.id);
      if (!Number.isFinite(id)) throw new Error('cancel_timer: id must be a number');
      return { ok: timers.cancel(id) };
    }
    default:
      throw new Error(`Unknown timer tool: ${name}`);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/agent/timerTools.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/agent/timerTools.ts tests/agent/timerTools.test.ts
git commit -m "feat(agent): set_timer/list_timers/cancel_timer tools"
```

---

## Task 8: Plumb new tools into `OpenAiAgent`

**Files:**

- Modify: `src/agent/openaiAgent.ts`
- Modify: `tests/agent/openaiAgent.test.ts` (add cases for one new tool from each set)

- [ ] **Step 1: Update `OpenAiAgentOptions`**

In `src/agent/openaiAgent.ts`, change the `memory` field type and add the system-prompt time hint. Replace the existing `OpenAiAgentOptions`:

```typescript
import type { MemoryStore } from '../memory/types.ts';

export interface OpenAiAgentOptions {
  mcp: McpClient;
  memory: MemoryStore;
  session: Session;
  systemPrompt: string;
  model: string;
  maxToolIterations?: number;
  llmClient: OpenAI;
  telegram: TelegramSender;
}
```

- [ ] **Step 2: Update tool registration + dispatch**

Add imports:

```typescript
import { REMINDER_TOOL_NAMES, buildReminderTools, executeReminderTool } from './reminderTools.ts';
import { TIMER_TOOL_NAMES, buildTimerTools, executeTimerTool } from './timerTools.ts';
```

Replace the `tools` line:

```typescript
const tools = [
  ...mcpTools,
  ...buildMemoryTools(),
  ...buildReminderTools(),
  ...buildTimerTools(),
  buildAskTool(),
  buildTelegramTool(),
].map((t) => ({ ...t, strict: t.strict ?? null }));
```

Inside the for-loop over `fnCalls`, replace the `MEMORY_TOOL_NAMES` check with a chain that also dispatches reminder + timer tools. The relevant block becomes:

```typescript
if (MEMORY_TOOL_NAMES.has(tc.name)) {
  try {
    const r = executeMemoryTool(this.opts.memory.profile, tc.name, args);
    resultText = JSON.stringify(r);
  } catch (e) {
    resultText = e instanceof Error ? e.message : String(e);
    isError = true;
  }
} else if (REMINDER_TOOL_NAMES.has(tc.name)) {
  try {
    const r = executeReminderTool(this.opts.memory.reminders, tc.name, args);
    resultText = JSON.stringify(r);
  } catch (e) {
    resultText = e instanceof Error ? e.message : String(e);
    isError = true;
  }
} else if (TIMER_TOOL_NAMES.has(tc.name)) {
  try {
    const r = executeTimerTool(this.opts.memory.timers, tc.name, args);
    resultText = JSON.stringify(r);
  } catch (e) {
    resultText = e instanceof Error ? e.message : String(e);
    isError = true;
  }
} else if (tc.name === TELEGRAM_TOOL_NAME) {
  // ... existing block unchanged
```

- [ ] **Step 3: Update `buildSystemMessage` to inject the current time**

Reminder/timer tools need the LLM to know "now" to resolve relative times. Inject it:

```typescript
private buildSystemMessage(): string {
  const base = this.opts.systemPrompt;
  const profile = this.opts.memory.profile.recall();
  const nowIso = new Date().toISOString();
  const nowMs = Date.now();
  const timeBlock = `\n\nCurrent time: ${nowIso} (Unix ms: ${nowMs}).`;
  if (Object.keys(profile).length === 0) return base + timeBlock;
  return `${base}${timeBlock}\n\nKnown user profile: ${JSON.stringify(profile)}`;
}
```

- [ ] **Step 4: Update existing agent tests to use the new memory shape**

The simplest fix: write a small `inMemoryStore()` helper inside `tests/agent/openaiAgent.test.ts` that returns a `MemoryStore` with no-op timers/reminders backed by in-memory arrays. Use the helpers from `reminderTools.test.ts` / `timerTools.test.ts` (factor them out into `tests/fixtures/memoryStore.ts` if they're reused).

Add a new test case that verifies `add_reminder` flows end-to-end through the agent (mock the LLM to call the tool). Skeleton:

```typescript
it('routes add_reminder to the reminders adapter', async () => {
  // 1. Configure a mock OpenAI client that emits a function_call for add_reminder
  //    on the first response, then a final text on the second.
  // 2. Build an OpenAiAgent with the in-memory MemoryStore.
  // 3. Call agent.respond("remind me at 1700000000000 to call mom").
  // 4. Expect store.reminders.listPending()[0].text === 'call mom'.
});
```

(Use the existing test patterns in the file — there's already a fake LLM client.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/agent/`
Expected: PASS — old tests adjusted, new test green.

- [ ] **Step 6: Commit**

```bash
git add src/agent/openaiAgent.ts tests/agent/openaiAgent.test.ts tests/fixtures/memoryStore.ts
git commit -m "feat(agent): register reminder + timer tools in OpenAiAgent"
```

---

## Task 9: Scheduler

A 15-second tick that asks each adapter for due rows and fires a callback. Crash-safe: any throw inside the tick is caught and logged; the next tick still runs.

**Files:**

- Create: `src/scheduling/types.ts`
- Create: `src/scheduling/scheduler.ts`
- Create: `tests/scheduling/scheduler.test.ts`

- [ ] **Step 1: Add types**

Create `src/scheduling/types.ts`:

```typescript
export type DueItem =
  | { kind: 'reminder'; id: number; text: string; fireAt: number }
  | { kind: 'timer'; id: number; label: string; fireAt: number; durationMs: number };

export interface FireSink {
  fire(item: DueItem): Promise<void>;
}
```

- [ ] **Step 2: Write the failing tests**

Create `tests/scheduling/scheduler.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Scheduler } from '../../src/scheduling/scheduler.ts';
import type { RemindersAdapter, TimersAdapter, Reminder, Timer } from '../../src/memory/types.ts';
import type { DueItem } from '../../src/scheduling/types.ts';

function reminders(initial: Reminder[]): RemindersAdapter {
  const items = [...initial];
  return {
    add: () => {
      throw new Error('not used');
    },
    listPending: () => items.filter((i) => i.status === 'pending'),
    listDue: (now) => items.filter((i) => i.status === 'pending' && i.fireAt <= now),
    markFired: (id, at) => {
      const r = items.find((x) => x.id === id);
      if (r) {
        r.status = 'fired';
        r.firedAt = at;
      }
    },
    cancel: () => false,
    get: (id) => items.find((x) => x.id === id) ?? null,
  };
}
function timers(initial: Timer[]): TimersAdapter {
  const items = [...initial];
  return {
    add: () => {
      throw new Error('not used');
    },
    listActive: () => items.filter((i) => i.status === 'active'),
    listDue: (now) => items.filter((i) => i.status === 'active' && i.fireAt <= now),
    markFired: (id, at) => {
      const t = items.find((x) => x.id === id);
      if (t) {
        t.status = 'fired';
        t.firedAt = at;
      }
    },
    cancel: () => false,
    get: (id) => items.find((x) => x.id === id) ?? null,
  };
}

describe('Scheduler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('fires due reminders and timers on each tick', async () => {
    vi.setSystemTime(2000);
    const fired: DueItem[] = [];
    const r = reminders([
      { id: 1, text: 'past', fireAt: 1000, status: 'pending', createdAt: 0, firedAt: null },
      { id: 2, text: 'future', fireAt: 5000, status: 'pending', createdAt: 0, firedAt: null },
    ]);
    const t = timers([
      {
        id: 1,
        label: 'pasta',
        fireAt: 1500,
        durationMs: 1,
        status: 'active',
        createdAt: 0,
        firedAt: null,
      },
    ]);
    const s = new Scheduler({
      reminders: r,
      timers: t,
      sink: { fire: async (it) => void fired.push(it) },
      tickMs: 100,
    });
    s.start();
    await vi.advanceTimersByTimeAsync(150);
    s.stop();
    expect(fired.map((f) => f.kind).sort()).toEqual(['reminder', 'timer']);
    expect(r.listPending()).toHaveLength(1); // future left alone
  });

  it('does not fire the same reminder twice across ticks', async () => {
    vi.setSystemTime(5000);
    const fired: DueItem[] = [];
    const r = reminders([
      { id: 1, text: 'x', fireAt: 1000, status: 'pending', createdAt: 0, firedAt: null },
    ]);
    const t = timers([]);
    const s = new Scheduler({
      reminders: r,
      timers: t,
      sink: { fire: async (it) => void fired.push(it) },
      tickMs: 100,
    });
    s.start();
    await vi.advanceTimersByTimeAsync(500);
    s.stop();
    expect(fired).toHaveLength(1);
  });

  it('does not mark fired if sink throws', async () => {
    vi.setSystemTime(5000);
    const r = reminders([
      { id: 1, text: 'x', fireAt: 1000, status: 'pending', createdAt: 0, firedAt: null },
    ]);
    const t = timers([]);
    const s = new Scheduler({
      reminders: r,
      timers: t,
      sink: {
        fire: async () => {
          throw new Error('telegram down');
        },
      },
      tickMs: 100,
    });
    s.start();
    await vi.advanceTimersByTimeAsync(150);
    s.stop();
    // Still pending — will retry next session
    expect(r.listPending()[0].id).toBe(1);
  });

  it('survives a thrown sink and continues firing other items', async () => {
    vi.setSystemTime(5000);
    const fired: DueItem[] = [];
    const r = reminders([
      { id: 1, text: 'a', fireAt: 1000, status: 'pending', createdAt: 0, firedAt: null },
      { id: 2, text: 'b', fireAt: 1100, status: 'pending', createdAt: 0, firedAt: null },
    ]);
    const t = timers([]);
    let calls = 0;
    const s = new Scheduler({
      reminders: r,
      timers: t,
      sink: {
        fire: async (it) => {
          calls++;
          if (it.kind === 'reminder' && it.id === 1) throw new Error('fail one');
          fired.push(it);
        },
      },
      tickMs: 100,
    });
    s.start();
    await vi.advanceTimersByTimeAsync(150);
    s.stop();
    expect(calls).toBe(2);
    expect(fired.map((f) => (f.kind === 'reminder' ? f.id : -1))).toEqual([2]);
  });

  it('stop() halts ticks', async () => {
    vi.setSystemTime(5000);
    const fired: DueItem[] = [];
    const r = reminders([
      { id: 1, text: 'x', fireAt: 6000, status: 'pending', createdAt: 0, firedAt: null },
    ]);
    const t = timers([]);
    const s = new Scheduler({
      reminders: r,
      timers: t,
      sink: { fire: async (it) => void fired.push(it) },
      tickMs: 100,
    });
    s.start();
    s.stop();
    vi.setSystemTime(7000);
    await vi.advanceTimersByTimeAsync(500);
    expect(fired).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/scheduling/scheduler.test.ts`
Expected: FAIL.

- [ ] **Step 4: Create `src/scheduling/scheduler.ts`**

```typescript
import type { RemindersAdapter, TimersAdapter } from '../memory/types.ts';
import type { DueItem, FireSink } from './types.ts';

export interface SchedulerOptions {
  reminders: RemindersAdapter;
  timers: TimersAdapter;
  sink: FireSink;
  /** Tick interval in ms. Default 15000. */
  tickMs?: number;
}

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly opts: SchedulerOptions;
  private readonly tickMs: number;

  constructor(opts: SchedulerOptions) {
    this.opts = opts;
    this.tickMs = opts.tickMs ?? 15_000;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    // schedule first tick after `tickMs` so unit tests can advance fake timers
    this.timer = setInterval(() => void this.tick(), this.tickMs);
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Exposed for tests; runs one cycle. */
  async tick(): Promise<void> {
    if (!this.running) return;
    const now = Date.now();
    let dueReminders, dueTimers;
    try {
      dueReminders = this.opts.reminders.listDue(now);
      dueTimers = this.opts.timers.listDue(now);
    } catch (err) {
      process.stderr.write(`[scheduler] listDue failed: ${(err as Error).message}\n`);
      return;
    }

    for (const r of dueReminders) {
      const item: DueItem = { kind: 'reminder', id: r.id, text: r.text, fireAt: r.fireAt };
      try {
        await this.opts.sink.fire(item);
        this.opts.reminders.markFired(r.id, Date.now());
      } catch (err) {
        process.stderr.write(
          `[scheduler] reminder ${r.id} fire failed: ${(err as Error).message}\n`,
        );
      }
    }
    for (const t of dueTimers) {
      const item: DueItem = {
        kind: 'timer',
        id: t.id,
        label: t.label,
        fireAt: t.fireAt,
        durationMs: t.durationMs,
      };
      try {
        await this.opts.sink.fire(item);
        this.opts.timers.markFired(t.id, Date.now());
      } catch (err) {
        process.stderr.write(`[scheduler] timer ${t.id} fire failed: ${(err as Error).message}\n`);
      }
    }
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/scheduling/scheduler.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 6: Commit**

```bash
git add src/scheduling/scheduler.ts src/scheduling/types.ts tests/scheduling/scheduler.test.ts
git commit -m "feat(scheduling): tick-based scheduler with crash-safe firing"
```

---

## Task 10: Wire scheduler + MemoryStore into `unified.ts`

**Files:**

- Modify: `src/cli/shared.ts`
- Modify: `src/cli/unified.ts`
- Modify: `tests/cli/shared.test.ts` and `tests/cli/unified.test.ts`

- [ ] **Step 1: Switch `shared.ts` to `MemoryStore`**

Replace `SqliteProfileMemory` with `openMemoryStore`:

```typescript
import { openMemoryStore } from '../memory/memoryStore.ts';
import type { MemoryStore } from '../memory/types.ts';

// CommonDeps:
memory: MemoryStore;

// In initializeCommonDependencies:
const memory = openMemoryStore(config.memory.dbPath);
// ... no other change here
```

`buildAgent` already passes `memory` to `OpenAiAgent`; the type now matches the new `OpenAiAgentOptions.memory: MemoryStore`. The agent in turn calls `memory.profile.recall()` (Task 8 already adjusted this).

`dispose()`: `memory.close()` is the same call.

- [ ] **Step 2: Build a Telegram-backed FireSink**

In `shared.ts`, expose a sink factory:

```typescript
import type { FireSink } from '../scheduling/types.ts';

const fireSink: FireSink = {
  async fire(item) {
    if (item.kind === 'reminder') {
      await telegram.send(`⏰ Reminder: ${item.text}`);
    } else {
      await telegram.send(`⏱ Timer "${item.label}" finished.`);
    }
  },
};
```

Add `fireSink` to the returned `CommonDeps`:

```typescript
fireSink: FireSink;
```

- [ ] **Step 3: Schedule the scheduler in `unified.ts`**

In `dispatch`, before the runner schedule, always start the scheduler when ANY runner is active (not for the no-op stub case):

```typescript
import { Scheduler } from '../scheduling/scheduler.ts';

// inside dispatch, after computing tasks:
const scheduler = new Scheduler({
  reminders: deps.memory.reminders,
  timers: deps.memory.timers,
  sink: deps.fireSink,
});
scheduler.start();
try {
  await Promise.race(tasks);
} finally {
  scheduler.stop();
}
```

The scheduler always runs in every mode (chat/voice/wake/telegram/both). Even in `chat` mode the user might `add_reminder`; we still want firing.

- [ ] **Step 4: Update tests**

`tests/cli/shared.test.ts`:

- Update `parseAgentMode` tests — unchanged, still pass.
- Add a test that `initializeCommonDependencies` returns `memory.reminders.listPending()` returning `[]` and `fireSink.fire(...)` not throwing for both kinds with a stubbed sender. Easiest: call it with a temp DB path.

`tests/cli/unified.test.ts`:

- Update `makeDeps()` to include a fake `memory` with `reminders`/`timers`/`profile` and a `fireSink` `vi.fn()`.
- Add a test that `dispatch` starts and stops the scheduler. Easiest: spy on `Scheduler.prototype.start` and `.stop` via `vi.spyOn`.

- [ ] **Step 5: Run all tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/cli/shared.ts src/cli/unified.ts tests/cli/shared.test.ts tests/cli/unified.test.ts
git commit -m "feat(cli): start scheduler alongside runners in unified dispatch"
```

---

## Task 11: Manual smoke tests

- [ ] **Step 1: Add a near-future reminder via chat**

```bash
AGENT_MODE=chat npm run start
> remind me to drink water in 1 minute
```

Expected: agent calls `add_reminder` with `fire_at` ≈ now+60_000 ms; replies confirming. Wait ~75 s. The Telegram bot sends `⏰ Reminder: drink water`.

- [ ] **Step 2: Set a timer via Telegram**

DM the bot: `set a 30-second timer called pasta`. Expected: tool call `set_timer`, confirmation. After 30 s, Telegram message `⏱ Timer "pasta" finished.`.

- [ ] **Step 3: Cancel a reminder**

DM: `list my reminders`. Then `cancel reminder 3` (use the id). Expected: `cancel_reminder` tool call, `{ ok: true }`. Wait past the original time — no fire.

- [ ] **Step 4: Crash recovery**

Add a reminder for ~2 minutes from now. `Ctrl+C` the process within 30 s. Restart: `npm run start`. Wait. The reminder fires.

- [ ] **Step 5: Edge case — reminder in the past**

Try `remind me yesterday at 9am`. Expected: agent says it can't (because the tool throws "fire_at is in the past"). Conversationally graceful — no crash.

If anything misbehaves, fix in a follow-up commit before docs.

---

## Task 12: Update `README.md`

**Files:**

- Modify: `README.md`

- [ ] **Step 1: Add a "Reminders & timers" section after the Telegram block**

````markdown
### Reminders & timers

The agent has three new abilities:

- `add_reminder(text, fire_at)` / `list_reminders` / `cancel_reminder`
- `set_timer(label, seconds)` / `list_timers` / `cancel_timer`

Reminders fire as Telegram messages prefixed with `⏰`; timers with `⏱`.
A 15-second tick scans the SQLite tables (`reminders`, `timers`) for due
rows. The scheduler runs in every `AGENT_MODE` — the agent process must
be alive when the time comes; we don't wake the Pi from sleep.

Try it:

```bash
npm run start
# In Telegram or wake-mode:
> remind me to drink water in 2 minutes
> set a 5-minute timer called pasta
> list my reminders
> cancel reminder 3
```
````

````

- [ ] **Step 2: Update Status section**

Add bullets:

```markdown
- One-shot reminders persisted in SQLite. Fire as a Telegram message
  while the agent is running; queued otherwise.
- Countdown timers (`set_timer 5 minutes pasta`) — same delivery channel.
````

- [ ] **Step 3: Format + commit**

```bash
npm run format
git add README.md
git commit -m "docs(readme): document reminders + timers"
```

---

## Task 13: Update `CLAUDE.md`

**Files:**

- Modify: `CLAUDE.md`

- [ ] **Step 1: Replace the Memory section**

Change the existing `### Memory (src/memory/)` block to describe the facade:

```markdown
### Memory (`src/memory/`)

`MemoryStore` (built by `openMemoryStore(dbPath)`) aggregates three
adapters that share **one** `better-sqlite3` connection:

- `profile: MemoryAdapter` — `remember` / `recall` / `forget` for the
  user profile (`profile` table).
- `reminders: RemindersAdapter` — one-shot reminders (`reminders` table).
- `timers: TimersAdapter` — countdown timers (`timers` table).

Migrations live as TS string constants in `migrations.ts`. Schema v2
adds `reminders` and `timers`. The current profile is injected into the
agent's system prompt on every turn alongside the current Unix-ms time
(needed by the LLM to resolve relative dates for `add_reminder`).

`SqliteProfileMemory.close()` is a no-op when constructed with an
externally-owned DB — the facade closes the DB once.
```

- [ ] **Step 2: Add a Scheduling section**

After the Memory section:

```markdown
### Scheduling (`src/scheduling/`)

A 15-second tick scans `reminders` and `timers` for due rows. Each due
row is sent through `FireSink.fire(DueItem)` — the runtime impl pushes a
formatted string to Telegram. On `fire` failure the row stays
`pending` / `active`, so the next tick (or the next process restart)
retries. There is no leader election: only one process must run the
scheduler at a time. (Trivially true on the Pi.)

Tools that produce these rows: `add_reminder` / `set_timer` (and their
list/cancel companions). The LLM resolves natural-language times itself;
the system prompt now includes `Current time: <ISO> (Unix ms: <int>)`
on every turn so it has a clock to anchor on.
```

- [ ] **Step 3: Update the entry-points table**

Add to the runners table:

```markdown
| `src/scheduling/scheduler.ts` | 15s tick that fires due reminders/timers via Telegram. Started by `unified.ts` regardless of `AGENT_MODE`. |
```

- [ ] **Step 4: Update the "Watch for" notes**

Add:

```markdown
- New schema migrations: bump the version, append to `MIGRATIONS`, never
  rewrite existing SQL. The Pi DB lives across restarts; out-of-order
  migrations corrupt it.
- New tool sets: register the tool names in the `*TOOL_NAMES` set, add
  to the `tools` array in `OpenAiAgent.respond`, and add a dispatch
  branch next to memory/reminder/timer.
```

- [ ] **Step 5: Format + commit**

```bash
npm run format
git add CLAUDE.md
git commit -m "docs(claude.md): document MemoryStore facade + scheduling"
```

---

## Task 14: Final verification

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: all green. New tests: ~4 (migrate v2) + 7 (reminders) + 5 (timers) + 2 (memoryStore) + 7 (reminderTools) + 5 (timerTools) + 5 (scheduler) + 1-2 (agent integration) = ~36 new assertions.

- [ ] **Step 2: Typecheck + lint**

Run: `npm run typecheck && npm run lint`

- [ ] **Step 3: Confirm migration is idempotent**

Run twice in a row: `node -e "import('./src/memory/memoryStore.ts').then(m => m.openMemoryStore('data/test.db').close())"`
Expected: no errors. The second run should not duplicate any rows or fail on `IF NOT EXISTS`.
Cleanup: `rm data/test.db data/test.db-wal data/test.db-shm` if those files exist.

- [ ] **Step 4: Smoke run**

Re-run Task 11 smoke tests if anything in the firing path changed since.

- [ ] **Step 5: PR description**

Suggested title: `feat: reminders + timers + scheduler`

Suggested body:

```
Plan 3 of personal-agent migration (docs/superpowers/plans/2026-04-26-reminders-timers.md).

- Schema v2: reminders + timers tables.
- New adapters: SqliteReminders, SqliteTimers (share the existing DB connection).
- MemoryStore facade replaces bare SqliteProfileMemory in agent + CLI.
- New tools on OpenAiAgent:
  - add_reminder / list_reminders / cancel_reminder
  - set_timer / list_timers / cancel_timer
- 15-second Scheduler started by unified.ts in every AGENT_MODE.
  Fires DueItems via Telegram; failures retried on next tick.
- System prompt now injects Current time on every turn so the LLM can
  resolve relative dates when it calls add_reminder.

Limitations: process must be alive at fire time. Pi sleep is out of
scope (acknowledged trade-off).
```

---

## Verification

End-to-end checklist (covered by Tasks 11 & 14):

- ✅ Reminder added now+90s via chat fires in Telegram on time.
- ✅ Timer set in Telegram fires `⏱ Timer "<label>" finished.` after the duration.
- ✅ `cancel_reminder` and `cancel_timer` prevent firing.
- ✅ `list_reminders` / `list_timers` show pending only.
- ✅ Killing the process and restarting before fire-time still fires correctly (DB-driven).
- ✅ Killing the process AT fire-time and restarting after fires on the next tick (item still `pending`).
- ✅ `add_reminder` with a past `fire_at` fails with a graceful agent reply.
- ✅ `npm test` passes; old tests still green.
- ✅ Migration v2 idempotent — re-running on an existing DB does nothing.

## Notes

- **Why not a per-row `setTimeout`?** Process restarts would lose them. The 15s tick costs ~one `SELECT WHERE fire_at <= ?` per table per tick — negligible.
- **Why not `node-cron`?** Adds a dep we don't need. One-shot reminders are not cron jobs.
- **Markup safety.** `⏰`/`⏱` and the user-supplied `text` go straight into `BotTelegramSender.send`, which posts as plain text (no `parse_mode`). Markdown injection is not an issue.
- **Time zones.** All `fire_at` values are stored as Unix ms (UTC). The LLM gets `Current time: <ISO>` in the system prompt — that's enough to do "tomorrow 9am Moscow" arithmetic. We don't store user TZ explicitly; if needed, add `tz` to the profile and the LLM picks it up automatically (`recall()` is already injected).
- **One scheduler per process.** Running two Pi processes against the same DB would double-fire. Don't do that. (The deploy compose runs one container.)
- **Sink composition.** `FireSink` is a single interface today. If we later want both Telegram + voice TTS for fires while the user is home, wrap with a `MultiSink` — out of scope here.
