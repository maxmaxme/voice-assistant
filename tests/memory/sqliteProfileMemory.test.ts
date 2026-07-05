import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { freshTestDb, type TestDb } from './helpers.ts';
import { captureLogs } from '../helpers/captureLogs.ts';
import { SqliteProfileMemory } from '../../src/memory/sqliteProfileMemory.ts';

describe('SqliteProfileMemory', () => {
  let h: TestDb;
  let m: SqliteProfileMemory;

  beforeEach(() => {
    h = freshTestDb();
    m = new SqliteProfileMemory(h.db);
  });
  afterEach(() => h.sqlite.close());

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

  // The DB is also hand-edited via the sqlite-web CRUD UI, so a non-JSON
  // `value` is a real scenario — one bad row must not break the whole recall.
  describe('corrupt rows (hand-edited DB)', () => {
    function insertRawRow(owner: string, key: string, value: string): void {
      h.sqlite
        .prepare(`INSERT INTO profile (owner, key, value, updated_at) VALUES (?, ?, ?, ?)`)
        .run(owner, key, value, Date.now());
    }

    it('recall() skips a corrupt row and still returns the healthy ones', () => {
      m.remember('name', 'Maxim');
      insertRawRow('household', 'broken', '{not json');
      m.remember('coffee', 'black');
      expect(m.recall()).toEqual({ name: 'Maxim', coffee: 'black' });
    });

    it('recall(key) of a corrupt row returns empty instead of throwing', () => {
      insertRawRow('household', 'broken', 'oops');
      expect(() => m.recall('broken')).not.toThrow();
      expect(m.recall('broken')).toEqual({});
    });

    it('a corrupt personal row does not shadow a healthy household value', () => {
      m.rememberFor('household', 'city', 'Madrid');
      insertRawRow('user:1', 'city', '{truncated');
      expect(m.recallFor(['household', 'user:1'], 'city')).toEqual({ city: 'Madrid' });
    });

    it('logs a warning identifying the corrupt row', () => {
      insertRawRow('household', 'broken', '{not json');
      const logs = captureLogs();
      try {
        m.recall();
        expect(logs.text()).toContain('broken');
        expect(logs.text()).toContain('"level":"warn"');
      } finally {
        logs.restore();
      }
    });
  });

  it('accepts an externally-owned db; close() does not close it', () => {
    const { sqlite, db } = freshTestDb();
    const store = new SqliteProfileMemory(db);
    store.remember('x', 1);
    expect(store.recall()).toEqual({ x: 1 });
    // close() must NOT close the externally-owned db
    store.close();
    expect(() => sqlite.prepare('SELECT 1').get()).not.toThrow();
    sqlite.close();
  });
});
