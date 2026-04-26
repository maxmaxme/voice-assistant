import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/memory/migrate.ts';
import { SqliteOffsetStore } from '../../src/telegram/sqliteOffsetStore.ts';

describe('SqliteOffsetStore', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
  });
  afterEach(() => {
    db.close();
  });

  it('returns 0 when key is absent', () => {
    const s = new SqliteOffsetStore({ db, key: 'telegram.offset' });
    expect(s.read()).toBe(0);
  });

  it('round-trips a value', () => {
    const s = new SqliteOffsetStore({ db, key: 'telegram.offset' });
    s.write(123);
    expect(s.read()).toBe(123);
    expect(new SqliteOffsetStore({ db, key: 'telegram.offset' }).read()).toBe(123);
  });

  it('monotonic write — never goes backwards', () => {
    const s = new SqliteOffsetStore({ db, key: 'telegram.offset' });
    s.write(10);
    s.write(5);
    expect(s.read()).toBe(10);
  });

  it('returns 0 when value is non-numeric junk', () => {
    db.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)').run(
      'telegram.offset',
      'garbage',
      Date.now(),
    );
    const s = new SqliteOffsetStore({ db, key: 'telegram.offset' });
    expect(s.read()).toBe(0);
  });

  it('different keys are isolated', () => {
    const a = new SqliteOffsetStore({ db, key: 'a' });
    const b = new SqliteOffsetStore({ db, key: 'b' });
    a.write(7);
    b.write(99);
    expect(a.read()).toBe(7);
    expect(b.read()).toBe(99);
  });
});
