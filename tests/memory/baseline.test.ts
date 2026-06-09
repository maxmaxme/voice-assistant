import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { applyMigrations, MIGRATIONS_FOLDER } from '../../src/memory/db.ts';

function initTag(): string {
  const journal: { entries: { idx: number; tag: string }[] } = JSON.parse(
    fs.readFileSync(path.join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
  );
  return journal.entries.find((e) => e.idx === 0)!.tag;
}

/** Build an in-memory DB that looks like the real prod DB before the Drizzle
 *  cutover: all tables created by the old migrations (via the real 0000 SQL),
 *  a legacy `schema_version` table at the given version, one user row, and NO
 *  `__drizzle_migrations` journal yet. */
function seedLegacyProd(sqlite: Database.Database, version: number): void {
  const raw = fs.readFileSync(path.join(MIGRATIONS_FOLDER, `${initTag()}.sql`), 'utf8');
  // Strip drizzle's statement-breakpoint markers so better-sqlite3 exec() doesn't
  // see them as syntax errors (exec runs multiple statements but not the marker).
  sqlite.exec(raw.split('--> statement-breakpoint').join('\n'));
  sqlite.exec(`CREATE TABLE schema_version (version INTEGER PRIMARY KEY);`);
  sqlite.prepare(`INSERT INTO schema_version (version) VALUES (?)`).run(version);
  sqlite.prepare(`INSERT INTO users (name, created_at, is_admin) VALUES ('Maxim', 1, 0)`).run();
}

/** Total number of migration files on disk — what a fully-migrated DB's
 *  journal row count must equal (the baseline shim seeds 0000_init's row;
 *  later migrations append theirs). */
function migrationsOnDisk(): number {
  const journal: { entries: unknown[] } = JSON.parse(
    fs.readFileSync(path.join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
  );
  return journal.entries.length;
}

function journalCount(sqlite: Database.Database): number {
  const row = sqlite
    .prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM __drizzle_migrations`)
    .get();
  return row?.n ?? 0;
}

describe('baseline shim on a legacy prod DB', () => {
  let sqlite: Database.Database;
  afterEach(() => sqlite.close());

  it('skips 0000_init when schema_version >= 12 and tables already exist', () => {
    sqlite = new Database(':memory:');
    seedLegacyProd(sqlite, 12);

    // Must NOT throw "table profile already exists".
    expect(() => applyMigrations(sqlite)).not.toThrow();
    expect(journalCount(sqlite)).toBe(migrationsOnDisk());

    // Pre-existing data is intact.
    const u = sqlite.prepare<[], { name: string }>(`SELECT name FROM users LIMIT 1`).get();
    expect(u?.name).toBe('Maxim');
  });

  it('is idempotent across reboots — second applyMigrations is a no-op', () => {
    sqlite = new Database(':memory:');
    seedLegacyProd(sqlite, 12);

    applyMigrations(sqlite);
    // Simulate a second boot of the same process against the same (now-baselined) DB.
    expect(() => applyMigrations(sqlite)).not.toThrow();
    expect(journalCount(sqlite)).toBe(migrationsOnDisk());
    const u = sqlite.prepare<[], { name: string }>(`SELECT name FROM users LIMIT 1`).get();
    expect(u?.name).toBe('Maxim');
  });

  it('throws a diagnosable error on a partially-migrated DB (schema_version < 12)', () => {
    sqlite = new Database(':memory:');
    seedLegacyProd(sqlite, 11);
    expect(() => applyMigrations(sqlite)).toThrow(/schema_version is 11.*requires >= 12/);
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
