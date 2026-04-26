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

  it('creates reminders and timers tables', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const tables = db
      .prepare<
        [],
        { name: string }
      >("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all();
    const names = tables.map((t) => t.name);
    expect(names).toContain('reminders');
    expect(names).toContain('timers');
    db.close();
  });

  it('records version 3', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const max = db.prepare<[], { v: number }>('SELECT MAX(version) AS v FROM schema_version').get();
    expect(max?.v).toBeGreaterThanOrEqual(3);
    db.close();
  });

  it('reminders has expected columns', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const cols = db.prepare<[], { name: string }>('PRAGMA table_info(reminders)').all();
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
    const cols = db.prepare<[], { name: string }>('PRAGMA table_info(timers)').all();
    const names = new Set(cols.map((c) => c.name));
    for (const c of ['id', 'label', 'fire_at', 'duration_ms', 'status', 'created_at', 'fired_at']) {
      expect(names.has(c)).toBe(true);
    }
    db.close();
  });
});
