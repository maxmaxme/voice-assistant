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
 *  dev (run from the repo root) and in Docker (`/app/src/memory` -> `/app/drizzle`,
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
 *  `created_at = entry.when`. The migrator runs a migration only when the latest
 *  recorded `created_at` is strictly less than that migration's `folderMillis`;
 *  seeding `created_at = when` makes 0000's own `when` not-less-than itself, so
 *  it's skipped while any later (newer-`when`) migration still applies. No-op on
 *  a fresh DB. */
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
  const version = maxV?.v ?? 0;
  if (version < 12) {
    // A `schema_version` table exists (so this is NOT a fresh DB) but it isn't at
    // the supported v12 baseline — a partially-migrated / stale-restore DB. Fail
    // loudly and diagnosably here rather than letting migrate() hit an opaque
    // "table already exists" when 0000_init runs against the pre-existing tables.
    throw new Error(
      `legacy schema_version is ${version}, but Drizzle baselining requires >= 12; ` +
        `this DB is in an unexpected partial state and is not safe to auto-migrate`,
    );
  }

  // Drizzle's own migrator also creates this table with IF NOT EXISTS (as
  // `id SERIAL`); whichever runs first wins and the other no-ops. The shapes are
  // compatible — SQLite treats SERIAL as plain INTEGER affinity, column order
  // matches, and the migrator only does named INSERTs / `SELECT id, hash, created_at`.
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

  const journal: Journal = JSON.parse(
    fs.readFileSync(path.join(migrationsFolder, 'meta', '_journal.json'), 'utf8'),
  );
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
