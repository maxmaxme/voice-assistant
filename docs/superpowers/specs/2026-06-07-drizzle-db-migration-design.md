# Migrate the DB layer to Drizzle ORM (synchronous, better-sqlite3)

- **Date:** 2026-06-07
- **Repo:** `voice-assistant`
- **Status:** design approved, ready for implementation plan

## Goal

Address the four pain points of the current `src/memory/` layer:

1. **Type safety** — move away from hand-written `Row` interfaces and
   `prepare<Params, Row>` generics toward types inferred from a schema.
2. **Less hand-written SQL** — a declarative schema and a query builder instead
   of SQL strings.
3. **Better migrations** — a standard tool instead of the hand-rolled runner.
4. **A single modern stack** for database access.

## Tool choice and the key constraint

Prisma / Drizzle / Kysely were considered. The deciding factor is
**synchronicity**. All current code accesses the DB synchronously: `recall()`,
`resolve()`, `isAdmin()`, `listDue()`, etc. return values directly, with no
`await`. Measured blast radius: **33 adapter call sites across 11 files**
outside `src/memory/` (`scheduler.ts`, `telegramTool.ts`, `memoryTools.ts`,
`scheduledActionTools.ts`, `unified.ts`, `users.ts`, `http.ts`,
`runners/telegram.ts`, `goalRunner.ts`, `openaiAgent.ts`, `telegrafReceiver.ts`).

- **Prisma** and **Kysely** are Promise-based → would force an `async` change
  across all 33 sites plus interfaces plus tests, for zero behavioral gain.
  Prisma additionally pulls a Rust query engine into the image and a separate
  migration workflow.
- **Drizzle** with the `drizzle-orm/better-sqlite3` driver executes queries
  **synchronously** (`.get()/.all()/.run()` return values directly) → code
  outside `src/memory/` stays untouched. **Drizzle is chosen.**

## Architecture principle: Drizzle hides behind the existing interfaces

The domain interfaces in `src/memory/types.ts` (`MemoryAdapter`,
`IdentitiesAdapter`, `ScheduledActionsAdapter`, `TelegramSessionsAdapter`,
`MemoryStore`, plus the DTOs `ProfileFacts`, `ScheduledAction`,
`NewScheduledAction`, `TelegramSessionRecord`, `PendingToolOutput`,
`IdentityResolution`, `Channel`) **stay unchanged**. Drizzle is an
implementation detail inside the store classes.

Consequence: `scope.ts`, the agent, the scheduler, the CLI, the Telegram
receiver, and all 33 call sites **do not change**. This is the whole point of
the synchronous choice.

## Components

### `src/memory/schema.ts` (new)

Describes the 5 tables via `sqliteTable(...)` from `drizzle-orm/sqlite-core`.
The final schema (the result of collapsing the current 12 migrations):

- **`profile`**: `owner TEXT NOT NULL DEFAULT 'household'`, `key TEXT NOT NULL`,
  `value TEXT NOT NULL`, `updated_at INTEGER NOT NULL`, PK `(owner, key)`.
- **`users`**: `id INTEGER PK AUTOINCREMENT`, `name TEXT NOT NULL`,
  `created_at INTEGER NOT NULL`, `is_admin INTEGER NOT NULL DEFAULT 0`.
- **`identities`**: `id INTEGER PK AUTOINCREMENT`, `channel TEXT NOT NULL`
  (CHECK `IN ('telegram','http','voice')`), `identity TEXT NOT NULL`,
  `user_id INTEGER NOT NULL REFERENCES users(id)`, `created_at INTEGER NOT NULL`,
  `last_used_at INTEGER` (nullable), UNIQUE `(channel, identity)`.
- **`scheduled_actions`**: `id INTEGER PK AUTOINCREMENT`, `goal TEXT NOT NULL`,
  `schedule_kind TEXT NOT NULL` (CHECK `IN ('once','cron')`),
  `schedule_expr TEXT NOT NULL`, `status TEXT NOT NULL DEFAULT 'active'`,
  `next_fire_at INTEGER NOT NULL`, `last_fired_at INTEGER`,
  `created_at INTEGER NOT NULL`, `owner_user_id INTEGER NOT NULL DEFAULT 1`;
  partial index `idx_scheduled_actions_due ON (next_fire_at) WHERE status='active'`.
- **`telegram_sessions`**: `chat_id INTEGER PK`, `last_response_id TEXT`,
  `pending_ask_call_id TEXT`, `updated_at INTEGER NOT NULL`,
  `pending_tool_outputs TEXT`.

Row types are inferred via `table.$inferSelect` / `table.$inferInsert` — the
hand-written `Row` interfaces (in `sqliteScheduledActions.ts`,
`sqliteTelegramSessions.ts`) and the `prepare<...>` generics are removed.

Note: the legacy `schema_version` table is **not** part of the new schema — its
role is taken over by Drizzle's journal (`__drizzle_migrations`). On prod it
stays in place as-is (harmless); dropping it is out of scope for this work.

### `src/memory/db.ts` (new) — DB open and migrations

Replaces the open wiring in `memoryStore.ts` and the whole of `migrate.ts`.
On `openMemoryStore(dbPath)` it:

1. `new Database(dbPath)` + `pragma('journal_mode = WAL')` +
   `pragma('busy_timeout = 5000')` (as today).
2. **Baseline shim** (see "Migrations").
3. `migrate(drizzleDb, { migrationsFolder })` — the synchronous migrator from
   `drizzle-orm/better-sqlite3/migrator`. `migrationsFolder` points at the
   `drizzle/` folder at the repo root, resolved relative to `import.meta.url`
   (robust both in dev from the repo root and in Docker from `/app`, where
   `COPY drizzle ./drizzle` places it).
4. Builds the store classes over `drizzle(db, { schema })` and returns a
   `MemoryStore`.

### Store classes (rewritten)

`sqliteProfileMemory.ts`, `identities.ts`, `sqliteScheduledActions.ts`,
`sqliteTelegramSessions.ts` — take a Drizzle wrapper instance
(`BetterSQLite3Database<typeof schema>`) instead of a raw `Database.Database`.
Queries go through the query builder, synchronously. Domain logic stays inside
the stores:

- JSON (de)serialization of `profile.value` and
  `telegram_sessions.pending_tool_outputs` (including the
  `isPendingToolOutput` / `parsePendingOutputs` validation);
- mapping of `schedule_kind` + `schedule_expr` ↔ the domain `Schedule`
  (`toSchedule`/`toScheduledAction`);
- snake_case (columns) → camelCase (DTOs).

`INSERT ... RETURNING ... .get()` (SQLite supports RETURNING) replaces the
`lastInsertRowid` + re-`SELECT` pair in `add()` and `addUser()`.

`memoryStore.ts` — becomes thin assembly: open the DB via `db.ts`, construct
the four stores, and return a `MemoryStore` with the same contract (`profile`,
`profileStore`, `identities`, `scheduledActions`, `telegramSessions`,
`close()`).

### Migrations: drizzle-kit + baseline of the prod DB

- `drizzle.config.ts` (new) points at `schema.ts`, dialect `sqlite`, output
  folder `drizzle/`.
- `drizzle-kit generate` produces `drizzle/0000_init.sql` — a snapshot of the
  **full** current schema — plus `drizzle/meta/_journal.json`.
- **Fresh DB** (`:memory:` tests, a new deployment): the runtime `migrate()`
  applies `0000_init` in full.
- **Prod DB** (tables already created by the 12 old migrations): drizzle's
  generated SQL emits `CREATE TABLE` without `IF NOT EXISTS`, so re-applying it
  would break. A **baseline shim** in `db.ts` is required, run before
  `migrate()`:
  - ensure the journal table `__drizzle_migrations` exists;
  - if the journal is empty **and** the DB contains the legacy `schema_version`
    table with a max version ≥ 12 (the signature of an already-migrated
    prod/older DB) — insert a row into `__drizzle_migrations` for `0000_init`
    (its hash from `_journal.json` + `created_at`), marking the snapshot as
    already applied;
  - on a fresh DB (no `schema_version`) the shim is a no-op → `migrate()` runs
    `0000_init` normally.
- Going forward, any schema change = edit `schema.ts` → `drizzle-kit generate`
  → new `.sql` → `migrate()` applies it on boot. ✅

Crash safety is preserved: Drizzle's better-sqlite3 migrator applies each file
and records it in the journal; WAL + busy_timeout stay.

### Removed

- `src/memory/migrate.ts` (hand-rolled runner).
- `src/memory/migrations.ts` (12 SQL migrations).
- The migration tests that become moot once history is collapsed (see below).

## Tests

Collapsing the 12 incremental migrations into a single snapshot removes the
intermediate schema states. Therefore the tests that exercise the step-by-step
runner and intermediate states **become moot and are removed**:

- `tests/memory/migrate.test.ts`
- `tests/memory/migrate.atomic.test.ts`
- `tests/memory/migrations.v7.test.ts`
- `tests/memory/migrations.v8.test.ts`
- `tests/memory/migrations.v11.test.ts`
- `tests/memory/migrationV4Backfill.test.ts`

Their behavior (the v4 reminders/timers backfill, the v7 `profile` rebuild with
`owner`, the v8 `role` drop, the v11 `last_used_at`, etc.) is already applied on
prod and baked into the `0000_init` baseline snapshot.

**Added:**

- a test that `migrate()` on a fresh `:memory:` DB creates the expected schema
  (tables, columns, the `idx_scheduled_actions_due` index, the UNIQUE
  `(channel, identity)` constraint);
- a baseline-shim test: on a simulated legacy DB (has `schema_version` at
  version 12, tables created by hand) `openMemoryStore` does not try to
  recreate the tables and marks `0000_init` as applied.

**Kept** (only the setup changes — a shared store-building helper instead of a
direct `runMigrations(db)`):

- `tests/memory/sqliteScheduledActions.test.ts`
- `tests/memory/identities.test.ts`
- `tests/memory/sqliteProfileMemory.test.ts`
- `tests/memory/sqliteProfileMemory.owner.test.ts`
- `tests/memory/scope.test.ts`
- `tests/memory/memoryStore.test.ts`

Tests outside `tests/memory/` (agent, scheduling, cli) do not change — the
adapter contract is preserved.

## Deployment / Docker

- `drizzle-orm` — runtime dependency; `drizzle-kit` — devDependency.
- **No codegen in the image** (unlike Prisma): types are pure TS inference,
  migrations are committed `.sql` files.
- Add `COPY drizzle ./drizzle` to the `Dockerfile` so the runtime `migrate()`
  can see the migration files (next to `COPY src ./src`).
- better-sqlite3, the arm64 build (Pi 5), and the `sqlite-web` admin UI are
  unchanged: the file stays vanilla SQLite.
- `package.json`: add the dependencies and scripts `db:generate`
  (`drizzle-kit generate`) and optionally `db:studio`.

## Repo conventions (to honor during implementation)

- Imports with the `.ts` extension, not `.js`.
- No TypeScript parameter properties — declare the field separately and assign
  it in the constructor (as today: `private readonly db; constructor(db) { this.db = db }`).
- No `Co-Authored-By` trailers in commits.

## File change map

| Action       | File                                                                                 |
| ------------ | ------------------------------------------------------------------------------------ |
| New          | `drizzle.config.ts`                                                                  |
| New          | `src/memory/schema.ts`                                                               |
| New          | `src/memory/db.ts`                                                                   |
| New          | `drizzle/0000_init.sql` + `drizzle/meta/_journal.json`                               |
| Rewrite      | `src/memory/sqliteProfileMemory.ts`                                                  |
| Rewrite      | `src/memory/identities.ts`                                                           |
| Rewrite      | `src/memory/sqliteScheduledActions.ts`                                               |
| Rewrite      | `src/memory/sqliteTelegramSessions.ts`                                               |
| Rewrite      | `src/memory/memoryStore.ts`                                                          |
| Delete       | `src/memory/migrate.ts`, `src/memory/migrations.ts`                                  |
| Delete       | the 6 migration tests (see "Tests")                                                  |
| Add          | 2 tests (schema snapshot + baseline shim)                                            |
| Setup fix    | the 6 store tests                                                                    |
| Unchanged    | `src/memory/types.ts`, `src/memory/scope.ts`, the 33 call sites, agent/scheduler/CLI |
| 1 line       | `Dockerfile` (`COPY drizzle ./drizzle`)                                              |
| Deps/scripts | `package.json`                                                                       |

## Definition of done

- `npm run typecheck` green (types inferred from `schema.ts`, no explicit `Row`
  interfaces).
- `npm test` green (new snapshot/baseline tests + kept store tests).
- Run against a copy of the prod `assistant.db`: the baseline shim fires, data
  is intact, `sqlite-web` reads the file.
- Run against an empty DB: `0000_init` creates the full schema.
- No `await` in `src/memory/` or in the 33 external call sites (synchronicity
  preserved).

## Explicitly out of scope

- Changing the data schema itself (carry it over as-is only).
- Touching other repos (`home-infra`, etc.) — beyond the fact that the public
  image is built by the same CI.
- Async refactoring of any code outside `src/memory/`.
