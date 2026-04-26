import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/memory/migrate.ts';
import { SqliteTimers } from '../../src/memory/sqliteTimers.ts';

describe('SqliteTimers', () => {
  let db: Database.Database;
  let t: SqliteTimers;
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    t = new SqliteTimers(db);
  });
  afterEach(() => db.close());

  it('starts empty', () => {
    expect(t.listActive()).toEqual([]);
  });

  it('add returns the row', () => {
    const x = t.add({ label: 'pasta', fireAt: 1000, durationMs: 500 });
    expect(x.id).toBeGreaterThan(0);
    expect(x.label).toBe('pasta');
    expect(x.durationMs).toBe(500);
    expect(x.status).toBe('active');
  });

  it('listDue returns only items at-or-past fireAt', () => {
    t.add({ label: 'a', fireAt: 100, durationMs: 1 });
    t.add({ label: 'b', fireAt: 1000, durationMs: 1 });
    expect(t.listDue(500).map((x) => x.label)).toEqual(['a']);
  });

  it('markFired updates status', () => {
    const x = t.add({ label: 'x', fireAt: 100, durationMs: 1 });
    t.markFired(x.id, 150);
    const r = t.get(x.id);
    expect(r?.status).toBe('fired');
    expect(r?.firedAt).toBe(150);
  });

  it('cancel returns true once', () => {
    const x = t.add({ label: 'x', fireAt: 100, durationMs: 1 });
    expect(t.cancel(x.id)).toBe(true);
    expect(t.cancel(x.id)).toBe(false);
  });
});
