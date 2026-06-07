# Drizzle DB Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Repo owner preference:** commits are listed per task per convention. Do **not** run `git commit`/`git push` without explicit confirmation from the owner. Use `.ts` import extensions (not `.js`); no TypeScript parameter properties; no `Co-Authored-By` trailers.

**Goal:** Replace the hand-written better-sqlite3 data layer in `src/memory/` with Drizzle ORM (synchronous better-sqlite3 driver) behind the unchanged adapter interfaces, with drizzle-kit migrations and a baseline shim for the existing prod DB.

**Architecture:** Drizzle is an implementation detail hidden behind the existing `MemoryStore`/`*Adapter` interfaces in `types.ts`. Tables are declared in `schema.ts`; row types are inferred. A single `0000_init` migration snapshots the current schema; on the prod DB a baseline shim marks it as already applied so `migrate()` skips it. No code outside `src/memory/` changes (all 33 call sites stay synchronous).

**Tech Stack:** TypeScript (Node 24 native type stripping), `drizzle-orm` (runtime), `drizzle-kit` (dev), `better-sqlite3`, Vitest.

---

## File Structure

| File                                                                                                                          | Responsibility                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `drizzle.config.ts` (new)                                                                                                     | drizzle-kit config: schema path, sqlite dialect, `out: ./drizzle`                               |
| `src/memory/schema.ts` (new)                                                                                                  | The 5 tables as `sqliteTable(...)`; exports `Db`-less schema namespace                          |
| `src/memory/db.ts` (new)                                                                                                      | `Db` type, `applyMigrations(sqlite)` (baseline shim + drizzle `migrate()`), `MIGRATIONS_FOLDER` |
| `drizzle/0000_init.sql` + `drizzle/meta/_journal.json` (new, generated)                                                       | Full-schema snapshot migration                                                                  |
| `src/memory/sqliteProfileMemory.ts` (rewrite)                                                                                 | Owner-aware profile KV via Drizzle                                                              |
| `src/memory/identities.ts` (rewrite)                                                                                          | Users + identities via Drizzle                                                                  |
| `src/memory/sqliteScheduledActions.ts` (rewrite)                                                                              | Scheduled actions via Drizzle                                                                   |
| `src/memory/sqliteTelegramSessions.ts` (rewrite)                                                                              | Telegram session records via Drizzle                                                            |
| `src/memory/memoryStore.ts` (rewrite)                                                                                         | Thin assembly: open DB, `applyMigrations`, build stores                                         |
| `src/memory/migrate.ts`, `src/memory/migrations.ts` (delete)                                                                  | Replaced by drizzle migrations                                                                  |
| `tests/memory/helpers.ts` (new)                                                                                               | `freshTestDb()` → `{ sqlite, db }` migrated in-memory                                           |
| `tests/memory/schema.snapshot.test.ts` (new)                                                                                  | Fresh-DB schema shape assertion                                                                 |
| `tests/memory/baseline.test.ts` (new)                                                                                         | Baseline-shim against a simulated legacy DB                                                     |
| `tests/memory/sqliteTelegramSessions.test.ts` (new)                                                                           | Round-trip coverage (no prior unit test existed)                                                |
| `tests/memory/{sqliteProfileMemory,sqliteProfileMemory.owner,identities,sqliteScheduledActions,scope}.test.ts` (modify setup) | Use `freshTestDb()` instead of `runMigrations`                                                  |
| `tests/memory/{migrate,migrate.atomic,migrations.v7,migrations.v8,migrations.v11,migrationV4Backfill}.test.ts` (delete)       | Step-by-step runner tests, now moot                                                             |
| `Dockerfile` (1 line)                                                                                                         | `COPY drizzle ./drizzle`                                                                        |
| `package.json`                                                                                                                | Add `drizzle-orm`, `drizzle-kit`; scripts `db:generate`, `db:studio`                            |

---

## Task 1: Dependencies, schema, and the generated baseline migration

**Files:**

- Modify: `package.json`
- Create: `drizzle.config.ts`
- Create: `src/memory/schema.ts`
- Create (generated): `drizzle/0000_init.sql`, `drizzle/meta/_journal.json`
- Test: `tests/memory/helpers.ts`, `tests/memory/schema.snapshot.test.ts`

- [ ] **Step 1: Install dependencies**

Run:

```bash
npm install drizzle-orm
npm install -D drizzle-kit
```

Expected: `package.json` gains `drizzle-orm` under `dependencies` and `drizzle-kit` under `devDependencies`; `package-lock.json` updated.

- [ ] **Step 2: Add npm scripts**

In `package.json` `"scripts"`, add:

```json
"db:generate": "drizzle-kit generate",
"db:studio": "drizzle-kit studio"
```

- [ ] **Step 3: Create `drizzle.config.ts`**

```ts
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/memory/schema.ts',
  out: './drizzle',
});
```

- [ ] **Step 4: Create `src/memory/schema.ts`**

```ts
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
} from 'drizzle-orm/sqlite-core';

export const profile = sqliteTable(
  'profile',
  {
    owner: text('owner').notNull().default('household'),
    key: text('key').notNull(),
    value: text('value').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.owner, t.key] })],
);

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  createdAt: integer('created_at').notNull(),
  isAdmin: integer('is_admin').notNull().default(0),
});

export const identities = sqliteTable(
  'identities',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    channel: text('channel', { enum: ['telegram', 'http', 'voice'] }).notNull(),
    identity: text('identity').notNull(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id),
    createdAt: integer('created_at').notNull(),
    lastUsedAt: integer('last_used_at'),
  },
  (t) => [
    unique('identities_channel_identity_unique').on(t.channel, t.identity),
    check('identities_channel_check', sql`${t.channel} IN ('telegram', 'http', 'voice')`),
  ],
);

export const scheduledActions = sqliteTable(
  'scheduled_actions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    goal: text('goal').notNull(),
    scheduleKind: text('schedule_kind', { enum: ['once', 'cron'] }).notNull(),
    scheduleExpr: text('schedule_expr').notNull(),
    status: text('status', { enum: ['active', 'done', 'cancelled', 'error'] })
      .notNull()
      .default('active'),
    nextFireAt: integer('next_fire_at').notNull(),
    lastFiredAt: integer('last_fired_at'),
    createdAt: integer('created_at').notNull(),
    ownerUserId: integer('owner_user_id').notNull().default(1),
  },
  (t) => [
    index('idx_scheduled_actions_due')
      .on(t.nextFireAt)
      .where(sql`status = 'active'`),
    check('scheduled_actions_kind_check', sql`${t.scheduleKind} IN ('once', 'cron')`),
  ],
);

export const telegramSessions = sqliteTable('telegram_sessions', {
  chatId: integer('chat_id').primaryKey(),
  lastResponseId: text('last_response_id'),
  pendingAskCallId: text('pending_ask_call_id'),
  updatedAt: integer('updated_at').notNull(),
  pendingToolOutputs: text('pending_tool_outputs'),
});
```

- [ ] **Step 5: Generate the baseline migration**

Run:

```bash
npm run db:generate -- --name init
```

Expected: creates `drizzle/0000_init.sql` (CREATE TABLE for all 5 tables + the `idx_scheduled_actions_due` index + CHECK/UNIQUE constraints) and `drizzle/meta/_journal.json` with one entry `{ idx: 0, tag: "0000_init", when: <millis>, ... }`. Inspect `0000_init.sql` and confirm all 5 tables, the partial index, the `(channel, identity)` UNIQUE, and the two CHECKs are present.

- [ ] **Step 6: Create the test helper `tests/memory/helpers.ts`**

```ts
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { fileURLToPath } from 'node:url';
import * as schema from '../../src/memory/schema.ts';
import type { Db } from '../../src/memory/db.ts';

const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url));

export interface TestDb {
  sqlite: Database.Database;
  db: Db;
}

/** A fresh, migrated in-memory database for store unit tests. */
export function freshTestDb(): TestDb {
  const sqlite = new Database(':memory:');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return { sqlite, db };
}
```

(Note: `Db` is created in Task 2. This file will not typecheck until then; that is expected and resolved by Task 2.)

- [ ] **Step 7: Write the schema snapshot test `tests/memory/schema.snapshot.test.ts`**

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { freshTestDb, type TestDb } from './helpers.ts';

describe('fresh DB schema', () => {
  let h: TestDb;
  afterEach(() => h?.sqlite.close());

  const tableNames = (h: TestDb): string[] =>
    h.sqlite
      .prepare<[], { name: string }>(
        `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`,
      )
      .all()
      .map((r) => r.name);

  it('creates all domain tables', () => {
    h = freshTestDb();
    expect(tableNames(h)).toEqual(
      expect.arrayContaining([
        'identities',
        'profile',
        'scheduled_actions',
        'telegram_sessions',
        'users',
      ]),
    );
  });

  it('creates the partial due index', () => {
    h = freshTestDb();
    const idx = h.sqlite
      .prepare<
        [],
        { name: string }
      >(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_scheduled_actions_due'`)
      .get();
    expect(idx?.name).toBe('idx_scheduled_actions_due');
  });
});
```

- [ ] **Step 8: Run the snapshot test (fails — `Db` undefined / db.ts missing)**

Run: `npx vitest run tests/memory/schema.snapshot.test.ts`
Expected: FAIL — `helpers.ts` cannot import `Db` from `./db.ts` (file does not exist yet).

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json drizzle.config.ts src/memory/schema.ts drizzle tests/memory/helpers.ts tests/memory/schema.snapshot.test.ts
git commit -m "feat(memory): add drizzle schema, config, and baseline migration"
```

---

## Task 2: `db.ts` — Db type, baseline shim, applyMigrations

**Files:**

- Create: `src/memory/db.ts`
- Test: `tests/memory/baseline.test.ts`

- [ ] **Step 1: Create `src/memory/db.ts`**

```ts
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema.ts';

export type Db = BetterSQLite3Database<typeof schema>;

/** Repo-root `drizzle/` folder. Resolved from this module so it works both in
 *  dev (run from the repo root) and in Docker (`/app/src/memory` → `/app/drizzle`,
 *  placed there by `COPY drizzle ./drizzle`). */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url));

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}
interface Journal {
  entries: JournalEntry[];
}

/** The prod DB predates drizzle: its tables were created by the 12 hand-written
 *  migrations and it has a `schema_version` table at version >= 12, but no
 *  `__drizzle_migrations` journal. Drizzle's generated `0000_init.sql` uses bare
 *  `CREATE TABLE` (no IF NOT EXISTS), so letting `migrate()` run it would throw.
 *  We mark `0000_init` as already applied by inserting its journal row, keyed on
 *  `created_at = entry.when` — the migrator skips any migration whose folder
 *  timestamp is <= the latest recorded `created_at`. No-op on a fresh DB. */
function baselineLegacy(sqlite: Database.Database, migrationsFolder: string): void {
  const hasLegacy = sqlite
    .prepare<
      [],
      { name: string }
    >(`SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'`)
    .get();
  if (!hasLegacy) {
    return;
  }
  const maxV = sqlite
    .prepare<[], { v: number | null }>(`SELECT MAX(version) AS v FROM schema_version`)
    .get();
  if (!maxV || (maxV.v ?? 0) < 12) {
    return;
  }

  sqlite.exec(
    `CREATE TABLE IF NOT EXISTS __drizzle_migrations (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       hash TEXT NOT NULL,
       created_at NUMERIC
     )`,
  );
  const seeded = sqlite
    .prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM __drizzle_migrations`)
    .get();
  if ((seeded?.n ?? 0) > 0) {
    return;
  }

  const journal = JSON.parse(
    fs.readFileSync(path.join(migrationsFolder, 'meta', '_journal.json'), 'utf8'),
  ) as Journal;
  const first = journal.entries.find((e) => e.idx === 0);
  if (!first) {
    throw new Error('drizzle journal has no idx 0 entry; cannot baseline');
  }
  const sqlContent = fs.readFileSync(path.join(migrationsFolder, `${first.tag}.sql`), 'utf8');
  const hash = createHash('sha256').update(sqlContent).digest('hex');
  sqlite
    .prepare(`INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)`)
    .run(hash, first.when);
}

/** Wrap a raw better-sqlite3 handle as a Drizzle db, baseline a legacy prod DB
 *  if needed, then apply pending migrations. Returns the Drizzle wrapper. */
export function applyMigrations(
  sqlite: Database.Database,
  migrationsFolder = MIGRATIONS_FOLDER,
): Db {
  const db = drizzle(sqlite, { schema });
  baselineLegacy(sqlite, migrationsFolder);
  migrate(db, { migrationsFolder });
  return db;
}
```

- [ ] **Step 2: Write the baseline shim test `tests/memory/baseline.test.ts`**

```ts
import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { applyMigrations, MIGRATIONS_FOLDER } from '../../src/memory/db.ts';

function initTag(): string {
  const journal = JSON.parse(
    fs.readFileSync(path.join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
  ) as { entries: { idx: number; tag: string }[] };
  return journal.entries.find((e) => e.idx === 0)!.tag;
}

describe('baseline shim on a legacy prod DB', () => {
  let sqlite: Database.Database;
  afterEach(() => sqlite.close());

  it('skips 0000_init when schema_version >= 12 and tables already exist', () => {
    sqlite = new Database(':memory:');
    // Simulate prod: tables created by the old migrations (use the real 0000 SQL),
    // plus the legacy schema_version table at v12. No __drizzle_migrations yet.
    sqlite.exec(fs.readFileSync(path.join(MIGRATIONS_FOLDER, `${initTag()}.sql`), 'utf8'));
    sqlite.exec(`CREATE TABLE schema_version (version INTEGER PRIMARY KEY);`);
    sqlite.exec(`INSERT INTO schema_version (version) VALUES (12);`);
    sqlite.prepare(`INSERT INTO users (name, created_at, is_admin) VALUES ('Maxim', 1, 0)`).run();

    // Must NOT throw "table profile already exists".
    expect(() => applyMigrations(sqlite)).not.toThrow();

    const journal = sqlite
      .prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM __drizzle_migrations`)
      .get();
    expect(journal?.n).toBe(1);

    // Pre-existing data is intact.
    const u = sqlite.prepare<[], { name: string }>(`SELECT name FROM users LIMIT 1`).get();
    expect(u?.name).toBe('Maxim');
  });

  it('is a no-op on a fresh DB (0000_init runs normally)', () => {
    sqlite = new Database(':memory:');
    expect(() => applyMigrations(sqlite)).not.toThrow();
    const t = sqlite
      .prepare<
        [],
        { name: string }
      >(`SELECT name FROM sqlite_master WHERE type='table' AND name='profile'`)
      .get();
    expect(t?.name).toBe('profile');
  });
});
```

- [ ] **Step 3: Run the baseline + snapshot tests**

Run: `npx vitest run tests/memory/baseline.test.ts tests/memory/schema.snapshot.test.ts`
Expected: PASS (both files). `db.ts` now provides `Db`, so `helpers.ts` typechecks.

- [ ] **Step 4: Commit**

```bash
git add src/memory/db.ts tests/memory/baseline.test.ts
git commit -m "feat(memory): drizzle migrate + legacy baseline shim"
```

---

## Task 3: Rewrite `SqliteProfileMemory`

**Files:**

- Modify: `src/memory/sqliteProfileMemory.ts` (rewrite)
- Modify: `tests/memory/sqliteProfileMemory.test.ts`, `tests/memory/sqliteProfileMemory.owner.test.ts`, `tests/memory/scope.test.ts` (setup)

- [ ] **Step 1: Update test setups to use `freshTestDb()`**

In `tests/memory/sqliteProfileMemory.test.ts`, replace the imports and `beforeEach`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { freshTestDb, type TestDb } from './helpers.ts';
import { SqliteProfileMemory } from '../../src/memory/sqliteProfileMemory.ts';

describe('SqliteProfileMemory', () => {
  let h: TestDb;
  let m: SqliteProfileMemory;

  beforeEach(() => {
    h = freshTestDb();
    m = new SqliteProfileMemory(h.db);
  });
  afterEach(() => h.sqlite.close());
  // ...existing it(...) blocks unchanged...
```

In `tests/memory/sqliteProfileMemory.owner.test.ts`, replace the helper:

```ts
import { describe, it, expect } from 'vitest';
import { freshTestDb } from './helpers.ts';
import { SqliteProfileMemory } from '../../src/memory/sqliteProfileMemory.ts';

function freshStore(): SqliteProfileMemory {
  return new SqliteProfileMemory(freshTestDb().db);
}
// ...existing it(...) blocks unchanged...
```

In `tests/memory/scope.test.ts`, replace the helper:

```ts
import { freshTestDb } from './helpers.ts';
import { SqliteProfileMemory } from '../../src/memory/sqliteProfileMemory.ts';
// ...other imports unchanged (makeScopedProfile etc.)...

function store(): SqliteProfileMemory {
  return new SqliteProfileMemory(freshTestDb().db);
}
```

(Remove the now-unused `Database`/`runMigrations` imports in all three files.)

- [ ] **Step 2: Run the three tests to verify they fail**

Run: `npx vitest run tests/memory/sqliteProfileMemory.test.ts tests/memory/sqliteProfileMemory.owner.test.ts tests/memory/scope.test.ts`
Expected: FAIL — `SqliteProfileMemory` still takes the old options object, so `new SqliteProfileMemory(h.db)` is a type/runtime error.

- [ ] **Step 3: Rewrite `src/memory/sqliteProfileMemory.ts`**

```ts
import { and, eq } from 'drizzle-orm';
import type { Db } from './db.ts';
import { profile } from './schema.ts';
import { HOUSEHOLD_OWNER } from './scope.ts';
import type { MemoryAdapter, ProfileFacts } from './types.ts';

export class SqliteProfileMemory implements MemoryAdapter {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  rememberFor(owner: string, key: string, value: unknown): void {
    const json = JSON.stringify(value);
    const now = Date.now();
    this.db
      .insert(profile)
      .values({ owner, key, value: json, updatedAt: now })
      .onConflictDoUpdate({
        target: [profile.owner, profile.key],
        set: { value: json, updatedAt: now },
      })
      .run();
  }

  /** Read the union of `owners`. Owners are applied in order, so a later
   *  owner's value overrides an earlier one's on key collision. */
  recallFor(owners: string[], key?: string): ProfileFacts {
    const out: ProfileFacts = {};
    for (const owner of owners) {
      if (key !== undefined) {
        const row = this.db
          .select({ value: profile.value })
          .from(profile)
          .where(and(eq(profile.owner, owner), eq(profile.key, key)))
          .get();
        if (row) {
          out[key] = JSON.parse(row.value);
        }
      } else {
        const rows = this.db
          .select({ key: profile.key, value: profile.value })
          .from(profile)
          .where(eq(profile.owner, owner))
          .all();
        for (const r of rows) {
          out[r.key] = JSON.parse(r.value);
        }
      }
    }
    return out;
  }

  forgetFor(owner: string, key: string): void {
    this.db
      .delete(profile)
      .where(and(eq(profile.owner, owner), eq(profile.key, key)))
      .run();
  }

  // --- back-compat MemoryAdapter: household scope ---
  remember(key: string, value: unknown): void {
    this.rememberFor(HOUSEHOLD_OWNER, key, value);
  }

  recall(key?: string): ProfileFacts {
    return this.recallFor([HOUSEHOLD_OWNER], key);
  }

  forget(key: string): void {
    this.forgetFor(HOUSEHOLD_OWNER, key);
  }

  close(): void {
    // DB lifecycle is owned by openMemoryStore (memoryStore.ts); nothing to do.
  }
}
```

- [ ] **Step 4: Run the three tests to verify they pass**

Run: `npx vitest run tests/memory/sqliteProfileMemory.test.ts tests/memory/sqliteProfileMemory.owner.test.ts tests/memory/scope.test.ts`
Expected: PASS (all three).

- [ ] **Step 5: Commit**

```bash
git add src/memory/sqliteProfileMemory.ts tests/memory/sqliteProfileMemory.test.ts tests/memory/sqliteProfileMemory.owner.test.ts tests/memory/scope.test.ts
git commit -m "refactor(memory): SqliteProfileMemory on drizzle"
```

---

## Task 4: Rewrite `IdentitiesStore`

**Files:**

- Modify: `src/memory/identities.ts` (rewrite)
- Modify: `tests/memory/identities.test.ts` (setup + `lastUsed` helper)

- [ ] **Step 1: Update `tests/memory/identities.test.ts` setup**

Replace imports and the local `store`/`withDb`/`lastUsed` helpers:

```ts
import { describe, it, expect } from 'vitest';
import type Database from 'better-sqlite3';
import { freshTestDb } from './helpers.ts';
import { IdentitiesStore, hashToken } from '../../src/memory/identities.ts';

function store(): IdentitiesStore {
  return new IdentitiesStore(freshTestDb().db);
}

function withDb(): { sqlite: Database.Database; s: IdentitiesStore } {
  const { sqlite, db } = freshTestDb();
  return { sqlite, s: new IdentitiesStore(db) };
}

function lastUsed(sqlite: Database.Database, channel: string, identity: string): number | null {
  const row = sqlite
    .prepare<
      [string, string],
      { last_used_at: number | null }
    >(`SELECT last_used_at FROM identities WHERE channel = ? AND identity = ?`)
    .get(channel, identity);
  return row ? row.last_used_at : null;
}
```

Then update any test body that destructured `{ db, s }` from `withDb()` to `{ sqlite, s }` and passes `sqlite` (not `db`) into `lastUsed(...)`.

- [ ] **Step 2: Run identities test to verify it fails**

Run: `npx vitest run tests/memory/identities.test.ts`
Expected: FAIL — `new IdentitiesStore(freshTestDb().db)` mismatches the current raw-`Database` constructor.

- [ ] **Step 3: Rewrite `src/memory/identities.ts`**

```ts
import { createHash } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import type { Db } from './db.ts';
import { identities, users } from './schema.ts';
import type { Channel, IdentitiesAdapter, IdentityResolution } from './types.ts';

/** Full sha256 hex of a bearer/device token. Raw tokens are never stored. */
export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export class IdentitiesStore implements IdentitiesAdapter {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  resolve(channel: Channel, identity: string): IdentityResolution | null {
    const row = this.db
      .select({ userId: identities.userId })
      .from(identities)
      .where(and(eq(identities.channel, channel), eq(identities.identity, identity)))
      .get();
    return row ? { userId: row.userId } : null;
  }

  touch(channel: Channel, identity: string): void {
    this.db
      .update(identities)
      .set({ lastUsedAt: Date.now() })
      .where(and(eq(identities.channel, channel), eq(identities.identity, identity)))
      .run();
  }

  identityFor(channel: Channel, userId: number): string | null {
    const row = this.db
      .select({ identity: identities.identity })
      .from(identities)
      .where(and(eq(identities.channel, channel), eq(identities.userId, userId)))
      .orderBy(asc(identities.id))
      .limit(1)
      .get();
    return row ? row.identity : null;
  }

  listTelegramUsers(): { userId: number; name: string; chatId: string }[] {
    return this.db
      .select({ userId: identities.userId, name: users.name, chatId: identities.identity })
      .from(identities)
      .innerJoin(users, eq(users.id, identities.userId))
      .where(eq(identities.channel, 'telegram'))
      .orderBy(asc(identities.id))
      .all();
  }

  addUser(name: string): number {
    const row = this.db
      .insert(users)
      .values({ name, createdAt: Date.now() })
      .returning({ id: users.id })
      .get();
    return Number(row.id);
  }

  attachIdentity(channel: Channel, identity: string, userId: number): void {
    this.db.insert(identities).values({ channel, identity, userId, createdAt: Date.now() }).run();
  }

  isAdmin(userId: number): boolean {
    const row = this.db
      .select({ isAdmin: users.isAdmin })
      .from(users)
      .where(eq(users.id, userId))
      .get();
    return row?.isAdmin === 1;
  }

  setAdmin(userId: number, isAdmin: boolean): void {
    this.db
      .update(users)
      .set({ isAdmin: isAdmin ? 1 : 0 })
      .where(eq(users.id, userId))
      .run();
  }

  isEmpty(): boolean {
    const row = this.db.select({ id: identities.id }).from(identities).limit(1).get();
    return row === undefined;
  }
}
```

- [ ] **Step 4: Run identities test to verify it passes**

Run: `npx vitest run tests/memory/identities.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/memory/identities.ts tests/memory/identities.test.ts
git commit -m "refactor(memory): IdentitiesStore on drizzle"
```

---

## Task 5: Rewrite `SqliteScheduledActions`

**Files:**

- Modify: `src/memory/sqliteScheduledActions.ts` (rewrite)
- Modify: `tests/memory/sqliteScheduledActions.test.ts` (setup)

- [ ] **Step 1: Update test setup**

Replace imports and `beforeEach` in `tests/memory/sqliteScheduledActions.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { freshTestDb, type TestDb } from './helpers.ts';
import { SqliteScheduledActions } from '../../src/memory/sqliteScheduledActions.ts';
import type { NewScheduledAction } from '../../src/memory/types.ts';

describe('SqliteScheduledActions', () => {
  let h: TestDb;
  let s: SqliteScheduledActions;

  const add = (input: Omit<NewScheduledAction, 'ownerUserId'> & { ownerUserId?: number }) =>
    s.add({ ownerUserId: 1, ...input });

  beforeEach(() => {
    h = freshTestDb();
    s = new SqliteScheduledActions(h.db);
  });
  afterEach(() => h.sqlite.close());
  // ...existing it(...) blocks unchanged...
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/memory/sqliteScheduledActions.test.ts`
Expected: FAIL — `new SqliteScheduledActions(h.db)` mismatches current raw-`Database` constructor.

- [ ] **Step 3: Rewrite `src/memory/sqliteScheduledActions.ts`**

```ts
import { and, asc, eq, inArray, lte } from 'drizzle-orm';
import type { Db } from './db.ts';
import { scheduledActions } from './schema.ts';
import type { Schedule } from '../scheduling/types.ts';
import type { NewScheduledAction, ScheduledAction, ScheduledActionsAdapter } from './types.ts';

type Row = typeof scheduledActions.$inferSelect;

const toSchedule = (kind: Row['scheduleKind'], expr: string): Schedule =>
  kind === 'once' ? { kind: 'once', at: Number(expr) } : { kind: 'cron', expr };

const toScheduledAction = (r: Row): ScheduledAction => ({
  id: r.id,
  goal: r.goal,
  schedule: toSchedule(r.scheduleKind, r.scheduleExpr),
  status: r.status,
  nextFireAt: r.nextFireAt,
  lastFiredAt: r.lastFiredAt,
  createdAt: r.createdAt,
  ownerUserId: r.ownerUserId,
});

export class SqliteScheduledActions implements ScheduledActionsAdapter {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  add(input: NewScheduledAction): ScheduledAction {
    const now = Date.now();
    const kind = input.schedule.kind;
    const expr = input.schedule.kind === 'once' ? String(input.schedule.at) : input.schedule.expr;
    const row = this.db
      .insert(scheduledActions)
      .values({
        goal: input.goal,
        scheduleKind: kind,
        scheduleExpr: expr,
        status: 'active',
        nextFireAt: input.nextFireAt,
        createdAt: now,
        ownerUserId: input.ownerUserId,
      })
      .returning()
      .get();
    return toScheduledAction(row);
  }

  listActiveForOwner(userId: number): ScheduledAction[] {
    return this.db
      .select()
      .from(scheduledActions)
      .where(and(eq(scheduledActions.status, 'active'), eq(scheduledActions.ownerUserId, userId)))
      .orderBy(asc(scheduledActions.nextFireAt))
      .all()
      .map(toScheduledAction);
  }

  listDue(now: number): ScheduledAction[] {
    return this.db
      .select()
      .from(scheduledActions)
      .where(and(eq(scheduledActions.status, 'active'), lte(scheduledActions.nextFireAt, now)))
      .orderBy(asc(scheduledActions.nextFireAt))
      .all()
      .map(toScheduledAction);
  }

  markFired(id: number, at: number, nextFireAt: number | null): void {
    if (nextFireAt === null) {
      this.db
        .update(scheduledActions)
        .set({ status: 'done', lastFiredAt: at })
        .where(and(eq(scheduledActions.id, id), eq(scheduledActions.status, 'active')))
        .run();
    } else {
      this.db
        .update(scheduledActions)
        .set({ nextFireAt, lastFiredAt: at })
        .where(and(eq(scheduledActions.id, id), eq(scheduledActions.status, 'active')))
        .run();
    }
  }

  markError(id: number): void {
    this.db
      .update(scheduledActions)
      .set({ status: 'error' })
      .where(and(eq(scheduledActions.id, id), inArray(scheduledActions.status, ['active', 'done'])))
      .run();
  }

  cancel(id: number, userId: number): boolean {
    const res = this.db
      .update(scheduledActions)
      .set({ status: 'cancelled' })
      .where(
        and(
          eq(scheduledActions.id, id),
          eq(scheduledActions.ownerUserId, userId),
          eq(scheduledActions.status, 'active'),
        ),
      )
      .run();
    return res.changes > 0;
  }

  get(id: number): ScheduledAction | null {
    const row = this.db.select().from(scheduledActions).where(eq(scheduledActions.id, id)).get();
    return row ? toScheduledAction(row) : null;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/memory/sqliteScheduledActions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/memory/sqliteScheduledActions.ts tests/memory/sqliteScheduledActions.test.ts
git commit -m "refactor(memory): SqliteScheduledActions on drizzle"
```

---

## Task 6: Rewrite `SqliteTelegramSessions`

**Files:**

- Modify: `src/memory/sqliteTelegramSessions.ts` (rewrite)
- Create: `tests/memory/sqliteTelegramSessions.test.ts`

- [ ] **Step 1: Write a new round-trip test `tests/memory/sqliteTelegramSessions.test.ts`**

(No unit test existed before; add coverage so the rewrite is guarded directly rather than only via telegram-layer tests.)

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { freshTestDb, type TestDb } from './helpers.ts';
import { SqliteTelegramSessions } from '../../src/memory/sqliteTelegramSessions.ts';

describe('SqliteTelegramSessions', () => {
  let h: TestDb;
  let s: SqliteTelegramSessions;

  beforeEach(() => {
    h = freshTestDb();
    s = new SqliteTelegramSessions(h.db);
  });
  afterEach(() => h.sqlite.close());

  it('returns null for an unknown chat', () => {
    expect(s.get(1)).toBeNull();
  });

  it('round-trips a record with pending tool outputs', () => {
    s.save(42, {
      lastResponseId: 'resp_1',
      pendingAskCallId: 'call_1',
      pendingToolOutputs: [{ callId: 'c1', output: 'ok' }],
    });
    expect(s.get(42)).toEqual({
      lastResponseId: 'resp_1',
      pendingAskCallId: 'call_1',
      pendingToolOutputs: [{ callId: 'c1', output: 'ok' }],
    });
  });

  it('upserts on conflict and drops empty pending outputs to undefined', () => {
    s.save(42, { lastResponseId: 'resp_1', pendingToolOutputs: [] });
    const rec = s.get(42);
    expect(rec?.lastResponseId).toBe('resp_1');
    expect(rec?.pendingToolOutputs).toBeUndefined();
  });

  it('delete removes the record', () => {
    s.save(7, { lastResponseId: 'x' });
    s.delete(7);
    expect(s.get(7)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/memory/sqliteTelegramSessions.test.ts`
Expected: FAIL — `new SqliteTelegramSessions(h.db)` mismatches current raw-`Database` constructor.

- [ ] **Step 3: Rewrite `src/memory/sqliteTelegramSessions.ts`**

```ts
import { eq } from 'drizzle-orm';
import type { Db } from './db.ts';
import { telegramSessions } from './schema.ts';
import type { PendingToolOutput, TelegramSessionRecord, TelegramSessionsAdapter } from './types.ts';

export class SqliteTelegramSessions implements TelegramSessionsAdapter {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  get(chatId: number): TelegramSessionRecord | null {
    const row = this.db
      .select({
        lastResponseId: telegramSessions.lastResponseId,
        pendingAskCallId: telegramSessions.pendingAskCallId,
        pendingToolOutputs: telegramSessions.pendingToolOutputs,
      })
      .from(telegramSessions)
      .where(eq(telegramSessions.chatId, chatId))
      .get();
    if (!row) {
      return null;
    }
    return {
      lastResponseId: row.lastResponseId ?? undefined,
      pendingAskCallId: row.pendingAskCallId ?? undefined,
      pendingToolOutputs: parsePendingOutputs(row.pendingToolOutputs),
    };
  }

  save(chatId: number, record: TelegramSessionRecord): void {
    const outputsJson =
      record.pendingToolOutputs && record.pendingToolOutputs.length > 0
        ? JSON.stringify(record.pendingToolOutputs)
        : null;
    const values = {
      chatId,
      lastResponseId: record.lastResponseId ?? null,
      pendingAskCallId: record.pendingAskCallId ?? null,
      pendingToolOutputs: outputsJson,
      updatedAt: Date.now(),
    };
    this.db
      .insert(telegramSessions)
      .values(values)
      .onConflictDoUpdate({
        target: telegramSessions.chatId,
        set: {
          lastResponseId: values.lastResponseId,
          pendingAskCallId: values.pendingAskCallId,
          pendingToolOutputs: values.pendingToolOutputs,
          updatedAt: values.updatedAt,
        },
      })
      .run();
  }

  delete(chatId: number): void {
    this.db.delete(telegramSessions).where(eq(telegramSessions.chatId, chatId)).run();
  }
}

function parsePendingOutputs(raw: string | null): PendingToolOutput[] | undefined {
  if (!raw) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) {
    return undefined;
  }
  const result: PendingToolOutput[] = [];
  for (const item of parsed) {
    if (isPendingToolOutput(item)) {
      result.push(item);
    }
  }
  return result.length > 0 ? result : undefined;
}

function isPendingToolOutput(value: unknown): value is PendingToolOutput {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const callId = Reflect.get(value, 'callId');
  const output = Reflect.get(value, 'output');
  return typeof callId === 'string' && typeof output === 'string';
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/memory/sqliteTelegramSessions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/memory/sqliteTelegramSessions.ts tests/memory/sqliteTelegramSessions.test.ts
git commit -m "refactor(memory): SqliteTelegramSessions on drizzle"
```

---

## Task 7: Rewrite `memoryStore.ts` assembly

**Files:**

- Modify: `src/memory/memoryStore.ts` (rewrite)
- Verify (no change needed): `tests/memory/memoryStore.test.ts`

- [ ] **Step 1: Rewrite `src/memory/memoryStore.ts`**

```ts
import Database from 'better-sqlite3';
import { applyMigrations } from './db.ts';
import { SqliteProfileMemory } from './sqliteProfileMemory.ts';
import { SqliteScheduledActions } from './sqliteScheduledActions.ts';
import { SqliteTelegramSessions } from './sqliteTelegramSessions.ts';
import { IdentitiesStore } from './identities.ts';
import type { MemoryStore } from './types.ts';

export function openMemoryStore(dbPath: string): MemoryStore {
  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  // Tolerate a second process (sqlite-web admin) holding a brief write lock.
  sqlite.pragma('busy_timeout = 5000');
  const db = applyMigrations(sqlite);
  const profile = new SqliteProfileMemory(db);
  const scheduledActions = new SqliteScheduledActions(db);
  const telegramSessions = new SqliteTelegramSessions(db);
  const identities = new IdentitiesStore(db);
  return {
    profile,
    profileStore: profile,
    identities,
    scheduledActions,
    telegramSessions,
    close() {
      sqlite.close();
    },
  };
}
```

- [ ] **Step 2: Run the memoryStore test (no setup change needed — it uses `openMemoryStore`)**

Run: `npx vitest run tests/memory/memoryStore.test.ts`
Expected: PASS (open, persist-across-reopen, multi-store on one DB).

- [ ] **Step 3: Commit**

```bash
git add src/memory/memoryStore.ts
git commit -m "refactor(memory): assemble stores over drizzle in openMemoryStore"
```

---

## Task 8: Remove the legacy migration runner and its tests

**Files:**

- Delete: `src/memory/migrate.ts`, `src/memory/migrations.ts`
- Delete: `tests/memory/migrate.test.ts`, `tests/memory/migrate.atomic.test.ts`, `tests/memory/migrations.v7.test.ts`, `tests/memory/migrations.v8.test.ts`, `tests/memory/migrations.v11.test.ts`, `tests/memory/migrationV4Backfill.test.ts`

- [ ] **Step 1: Confirm nothing still imports the legacy runner**

Run: `grep -rn "migrate.ts\|migrations.ts\|runMigrations\|MIGRATIONS" src tests | grep -v "drizzle\|db.ts\|__drizzle"`
Expected: no matches (every reference to `runMigrations`/`MIGRATIONS` was removed in Tasks 2–7). If any remain, fix them before deleting.

- [ ] **Step 2: Delete the files**

```bash
git rm src/memory/migrate.ts src/memory/migrations.ts \
  tests/memory/migrate.test.ts tests/memory/migrate.atomic.test.ts \
  tests/memory/migrations.v7.test.ts tests/memory/migrations.v8.test.ts \
  tests/memory/migrations.v11.test.ts tests/memory/migrationV4Backfill.test.ts
```

- [ ] **Step 3: Run the full memory test directory**

Run: `npx vitest run tests/memory`
Expected: PASS — remaining files: `helpers.ts` (not a test), `schema.snapshot`, `baseline`, `sqliteProfileMemory`, `sqliteProfileMemory.owner`, `identities`, `sqliteScheduledActions`, `sqliteTelegramSessions`, `scope`, `memoryStore`.

- [ ] **Step 4: Commit**

```bash
git add -A src/memory tests/memory
git commit -m "chore(memory): drop hand-rolled migration runner and its step tests"
```

---

## Task 9: Docker, full verification, and prod-DB dry run

**Files:**

- Modify: `Dockerfile`

- [ ] **Step 1: Add the migrations folder to the image**

In `Dockerfile`, after `COPY src ./src` and `COPY tsconfig.json ./`, add:

```dockerfile
# Drizzle migration files, read at runtime by applyMigrations().
COPY drizzle ./drizzle
```

- [ ] **Step 2: Typecheck the whole project**

Run: `npm run typecheck`
Expected: PASS — no `Row` interfaces, no references to deleted modules, `Db` inferred types flow through the stores.

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: PASS — memory tests plus all agent/scheduling/cli tests (which exercise the adapters through the unchanged interfaces).

- [ ] **Step 4: Lint**

Run: `npx eslint .`
Expected: clean (no unused `Database`/`runMigrations` imports left behind).

- [ ] **Step 5: Prod-DB baseline dry run (manual, on a copy)**

```bash
cp /path/to/prod/assistant.db /tmp/assistant-copy.db
MEMORY_DB_PATH=/tmp/assistant-copy.db node -e "import('./src/memory/memoryStore.ts').then(m => { const s = m.openMemoryStore(process.env.MEMORY_DB_PATH); console.log('users empty?', s.identities.isEmpty()); console.log('due:', s.scheduledActions.listDue(Date.now()).length); s.close(); console.log('OK — baseline skipped 0000_init, data intact'); })"
```

Expected: no "table already exists" error; reads return the existing prod data; process exits 0. Confirm with `sqlite3 /tmp/assistant-copy.db "SELECT COUNT(*) FROM __drizzle_migrations;"` → `1`.

- [ ] **Step 6: Commit**

```bash
git add Dockerfile
git commit -m "build: copy drizzle migrations into the image"
```

---

## Self-Review Notes

- **Spec coverage:** schema.ts (§2), db.ts + baseline (§4), store rewrites (§3), test changes (§Tests), Docker COPY + deps (§Deployment), removed runner/tests (§Removed), conventions honored. All mapped to Tasks 1–9.
- **Synchronicity (DoD):** every store method uses `.get()/.all()/.run()` synchronously; no `await` introduced; the 33 external call sites and `types.ts`/`scope.ts` are untouched.
- **Type consistency:** stores take `Db` (from `db.ts`); `Row` in scheduled actions is `typeof scheduledActions.$inferSelect`; `helpers.ts` returns `{ sqlite, db }`; `applyMigrations(sqlite)` returns `Db`; `MIGRATIONS_FOLDER` shared between `db.ts`, `helpers.ts`, and `baseline.test.ts`.
- **No placeholders:** every code step contains complete code; every run step states the exact command and expected result.
