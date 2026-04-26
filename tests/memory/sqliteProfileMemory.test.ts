import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/memory/migrate.ts';
import { SqliteProfileMemory } from '../../src/memory/sqliteProfileMemory.ts';

describe('SqliteProfileMemory', () => {
  let m: SqliteProfileMemory;

  beforeEach(() => {
    m = new SqliteProfileMemory({ dbPath: ':memory:' });
  });
  afterEach(() => m.close());

  it('starts empty', () => {
    expect(m.recall()).toEqual({});
  });

  it('remember + recall by key', () => {
    m.remember('name', 'Maxim');
    expect(m.recall('name')).toEqual({ name: 'Maxim' });
  });

  it('remember overwrites existing key', () => {
    m.remember('temp', 22);
    m.remember('temp', 21);
    expect(m.recall('temp')).toEqual({ temp: 21 });
  });

  it('recall() with no key returns full profile', () => {
    m.remember('name', 'Maxim');
    m.remember('coffee', { sugar: false });
    expect(m.recall()).toEqual({ name: 'Maxim', coffee: { sugar: false } });
  });

  it('forget removes a key', () => {
    m.remember('name', 'Maxim');
    m.forget('name');
    expect(m.recall()).toEqual({});
  });

  it('forget on missing key is a no-op', () => {
    expect(() => m.forget('nope')).not.toThrow();
  });

  it('handles non-string values via JSON', () => {
    m.remember('list', [1, 2, 3]);
    m.remember('flag', true);
    expect(m.recall()).toEqual({ list: [1, 2, 3], flag: true });
  });

  it('accepts an externally-owned Database', () => {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    runMigrations(db);
    const m = new SqliteProfileMemory({ db });
    m.remember('x', 1);
    expect(m.recall()).toEqual({ x: 1 });
    // close() must NOT close the externally-owned db
    m.close();
    expect(() => db.prepare('SELECT 1').get()).not.toThrow();
    db.close();
  });
});
