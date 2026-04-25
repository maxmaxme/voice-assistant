import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/memory/migrate.js';

describe('runMigrations', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });
  afterEach(() => db.close());

  it('creates profile and schema_version tables', () => {
    runMigrations(db);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain('profile');
    expect(names).toContain('schema_version');
  });

  it('records version 1', () => {
    runMigrations(db);
    const row = db.prepare('SELECT version FROM schema_version').get() as { version: number };
    expect(row.version).toBe(1);
  });

  it('is idempotent', () => {
    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();
  });
});
