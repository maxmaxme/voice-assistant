import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/memory/migrate.ts';

function versions(db: Database.Database): number[] {
  return db
    .prepare<[], { version: number }>('SELECT version FROM schema_version ORDER BY version')
    .all()
    .map((r) => r.version);
}

function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare<
      [string],
      { name: string }
    >(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`)
    .get(name);
  return row !== undefined;
}

describe('runMigrations atomicity', () => {
  it('rolls back a failing migration entirely and does not record its version', () => {
    const db = new Database(':memory:');
    const migrations = [
      {
        version: 1,
        sql: `CREATE TABLE good (x); INSERT OR IGNORE INTO schema_version (version) VALUES (1);`,
      },
      {
        version: 2,
        // `partial` is created, then a bad statement throws — the whole
        // migration must roll back, leaving no `partial` table and no v2.
        sql: `CREATE TABLE partial (x); SELECT no_such_column; INSERT OR IGNORE INTO schema_version (version) VALUES (2);`,
      },
    ];
    expect(() => runMigrations(db, migrations)).toThrow();
    expect(versions(db)).toEqual([1]); // v1 committed, v2 not
    expect(tableExists(db, 'good')).toBe(true);
    expect(tableExists(db, 'partial')).toBe(false); // rolled back
  });

  it('retries cleanly after a fix — no leftover from the failed attempt', () => {
    const db = new Database(':memory:');
    const bad = [{ version: 1, sql: `CREATE TABLE t (x); SELECT no_such_column;` }];
    expect(() => runMigrations(db, bad)).toThrow();
    expect(tableExists(db, 't')).toBe(false); // not left half-applied

    const fixed = [
      {
        version: 1,
        sql: `CREATE TABLE t (x); INSERT OR IGNORE INTO schema_version (version) VALUES (1);`,
      },
    ];
    runMigrations(db, fixed);
    expect(tableExists(db, 't')).toBe(true);
    expect(versions(db)).toEqual([1]);
  });

  it('applies the real migration chain fully (through v10)', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    expect(versions(db)).toContain(10);
  });
});
