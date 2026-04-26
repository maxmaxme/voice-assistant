import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/memory/migrate.ts';
import { SqliteScheduledActions } from '../../src/memory/sqliteScheduledActions.ts';

describe('SqliteScheduledActions', () => {
  let db: Database.Database;
  let s: SqliteScheduledActions;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    s = new SqliteScheduledActions(db);
  });
  afterEach(() => db.close());

  it('starts empty', () => {
    expect(s.listActive()).toEqual([]);
  });

  it('round-trips a once schedule', () => {
    const out = s.add({
      goal: 'do thing',
      schedule: { kind: 'once', at: 1000 },
      nextFireAt: 1000,
    });
    expect(out.id).toBeGreaterThan(0);
    expect(out.goal).toBe('do thing');
    expect(out.schedule).toEqual({ kind: 'once', at: 1000 });
    expect(out.nextFireAt).toBe(1000);
    expect(out.status).toBe('active');
    expect(out.lastFiredAt).toBeNull();

    const re = s.get(out.id);
    expect(re?.schedule).toEqual({ kind: 'once', at: 1000 });
  });

  it('round-trips a cron schedule', () => {
    const out = s.add({
      goal: 'morning ping',
      schedule: { kind: 'cron', expr: '0 8 * * *' },
      nextFireAt: 12345,
    });
    expect(out.schedule).toEqual({ kind: 'cron', expr: '0 8 * * *' });

    const re = s.get(out.id);
    expect(re?.schedule).toEqual({ kind: 'cron', expr: '0 8 * * *' });
    expect(re?.nextFireAt).toBe(12345);
  });

  it('listActive returns only active rows ordered by next_fire_at asc', () => {
    s.add({ goal: 'b', schedule: { kind: 'once', at: 200 }, nextFireAt: 200 });
    s.add({ goal: 'a', schedule: { kind: 'once', at: 100 }, nextFireAt: 100 });
    const c = s.add({ goal: 'c', schedule: { kind: 'once', at: 50 }, nextFireAt: 50 });
    s.cancel(c.id);
    expect(s.listActive().map((x) => x.goal)).toEqual(['a', 'b']);
  });

  it('listDue filters by next_fire_at <= now and status=active', () => {
    s.add({ goal: 'past', schedule: { kind: 'once', at: 100 }, nextFireAt: 100 });
    s.add({ goal: 'future', schedule: { kind: 'once', at: 1000 }, nextFireAt: 1000 });
    expect(s.listDue(500).map((x) => x.goal)).toEqual(['past']);
  });

  it('markFired with null nextFireAt marks done and stamps last_fired_at', () => {
    const x = s.add({
      goal: 'one',
      schedule: { kind: 'once', at: 100 },
      nextFireAt: 100,
    });
    s.markFired(x.id, 200, null);
    const re = s.get(x.id);
    expect(re?.status).toBe('done');
    expect(re?.lastFiredAt).toBe(200);
  });

  it('markFired with nextFireAt updates next_fire_at, status stays active', () => {
    const x = s.add({
      goal: 'cron',
      schedule: { kind: 'cron', expr: '0 8 * * *' },
      nextFireAt: 100,
    });
    s.markFired(x.id, 100, 500);
    const re = s.get(x.id);
    expect(re?.status).toBe('active');
    expect(re?.nextFireAt).toBe(500);
    expect(re?.lastFiredAt).toBe(100);
  });

  it('markError marks the row as error', () => {
    const x = s.add({
      goal: 'bad',
      schedule: { kind: 'once', at: 100 },
      nextFireAt: 100,
    });
    s.markError(x.id);
    const re = s.get(x.id);
    expect(re?.status).toBe('error');
  });

  it('cancel returns true on active and false on second call', () => {
    const x = s.add({
      goal: 'x',
      schedule: { kind: 'once', at: 100 },
      nextFireAt: 100,
    });
    expect(s.cancel(x.id)).toBe(true);
    expect(s.cancel(x.id)).toBe(false);
  });

  it('cancel non-existent id returns false', () => {
    expect(s.cancel(99999)).toBe(false);
  });

  it('get on missing id returns null', () => {
    expect(s.get(99999)).toBeNull();
  });
});
