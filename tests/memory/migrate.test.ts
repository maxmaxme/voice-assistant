import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/memory/migrate.ts';

describe('runMigrations', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });
  afterEach(() => db.close());

  it('creates profile and schema_version tables', () => {
    runMigrations(db);
    const tables = db
      .prepare<
        [],
        { name: string }
      >("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all();
    const names = tables.map((t) => t.name);
    expect(names).toContain('profile');
    expect(names).toContain('schema_version');
  });

  it('records version 1', () => {
    runMigrations(db);
    const row = db.prepare<[], { version: number }>('SELECT version FROM schema_version').get();
    expect(row?.version).toBe(1);
  });

  it('is idempotent', () => {
    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();
  });

  it('records version 3', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const max = db.prepare<[], { v: number }>('SELECT MAX(version) AS v FROM schema_version').get();
    expect(max?.v).toBeGreaterThanOrEqual(3);
    db.close();
  });

  it('drops the dead kv/reminders/timers tables by the end of the chain (v9)', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const tables = db
      .prepare<
        [],
        { name: string }
      >("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all();
    const names = tables.map((t) => t.name);
    expect(names).not.toContain('kv');
    expect(names).not.toContain('reminders');
    expect(names).not.toContain('timers');
    db.close();
  });
});
