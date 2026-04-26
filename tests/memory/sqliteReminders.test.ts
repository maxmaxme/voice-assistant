import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/memory/migrate.ts';
import { SqliteReminders } from '../../src/memory/sqliteReminders.ts';

describe('SqliteReminders', () => {
  let db: Database.Database;
  let r: SqliteReminders;
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    r = new SqliteReminders(db);
  });
  afterEach(() => db.close());

  it('starts empty', () => {
    expect(r.listPending()).toEqual([]);
  });

  it('add returns the row with assigned id', () => {
    const out = r.add({ text: 'call mom', fireAt: 1000 });
    expect(out.id).toBeGreaterThan(0);
    expect(out.text).toBe('call mom');
    expect(out.fireAt).toBe(1000);
    expect(out.status).toBe('pending');
    expect(out.firedAt).toBeNull();
  });

  it('listPending returns only pending in fire_at order', () => {
    r.add({ text: 'b', fireAt: 200 });
    r.add({ text: 'a', fireAt: 100 });
    const fired = r.add({ text: 'c', fireAt: 50 });
    r.markFired(fired.id, 50);
    const pending = r.listPending();
    expect(pending.map((p) => p.text)).toEqual(['a', 'b']);
  });

  it('listDue returns only items with fire_at <= now', () => {
    r.add({ text: 'past', fireAt: 100 });
    r.add({ text: 'future', fireAt: 1000 });
    expect(r.listDue(500).map((p) => p.text)).toEqual(['past']);
  });

  it('markFired flips status and stamps fired_at', () => {
    const x = r.add({ text: 'x', fireAt: 100 });
    r.markFired(x.id, 200);
    const re = r.get(x.id);
    expect(re?.status).toBe('fired');
    expect(re?.firedAt).toBe(200);
  });

  it('cancel returns true on pending and false on missing/already-cancelled', () => {
    const x = r.add({ text: 'x', fireAt: 100 });
    expect(r.cancel(x.id)).toBe(true);
    expect(r.cancel(x.id)).toBe(false);
    expect(r.cancel(99999)).toBe(false);
  });

  it('cancelled reminders are not in listPending', () => {
    const x = r.add({ text: 'x', fireAt: 100 });
    r.cancel(x.id);
    expect(r.listPending()).toEqual([]);
  });
});
