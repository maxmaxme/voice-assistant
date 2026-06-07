import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { freshTestDb, type TestDb } from './helpers.ts';
import { SqliteScheduledActions } from '../../src/memory/sqliteScheduledActions.ts';
import type { NewScheduledAction } from '../../src/memory/types.ts';

describe('SqliteScheduledActions', () => {
  let h: TestDb;
  let s: SqliteScheduledActions;

  // Default owner for the single-user cases; owner-scoping has its own tests.
  const add = (input: Omit<NewScheduledAction, 'ownerUserId'> & { ownerUserId?: number }) =>
    s.add({ ownerUserId: 1, ...input });

  beforeEach(() => {
    h = freshTestDb();
    s = new SqliteScheduledActions(h.db);
  });
  afterEach(() => h.sqlite.close());

  it('starts empty', () => {
    expect(s.listActiveForOwner(1)).toEqual([]);
  });

  it('round-trips a once schedule', () => {
    const out = add({
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
    expect(out.ownerUserId).toBe(1);

    const re = s.get(out.id);
    expect(re?.schedule).toEqual({ kind: 'once', at: 1000 });
    expect(re?.ownerUserId).toBe(1);
  });

  it('round-trips a cron schedule', () => {
    const out = add({
      goal: 'morning ping',
      schedule: { kind: 'cron', expr: '0 8 * * *' },
      nextFireAt: 12345,
    });
    expect(out.schedule).toEqual({ kind: 'cron', expr: '0 8 * * *' });

    const re = s.get(out.id);
    expect(re?.schedule).toEqual({ kind: 'cron', expr: '0 8 * * *' });
    expect(re?.nextFireAt).toBe(12345);
  });

  it('listActiveForOwner returns only active rows ordered by next_fire_at asc', () => {
    add({ goal: 'b', schedule: { kind: 'once', at: 200 }, nextFireAt: 200 });
    add({ goal: 'a', schedule: { kind: 'once', at: 100 }, nextFireAt: 100 });
    const c = add({ goal: 'c', schedule: { kind: 'once', at: 50 }, nextFireAt: 50 });
    s.cancel(c.id, 1);
    expect(s.listActiveForOwner(1).map((x) => x.goal)).toEqual(['a', 'b']);
  });

  it('listActiveForOwner is scoped per owner', () => {
    add({ goal: 'mine', schedule: { kind: 'once', at: 100 }, nextFireAt: 100, ownerUserId: 1 });
    add({ goal: 'theirs', schedule: { kind: 'once', at: 100 }, nextFireAt: 100, ownerUserId: 2 });
    expect(s.listActiveForOwner(1).map((x) => x.goal)).toEqual(['mine']);
    expect(s.listActiveForOwner(2).map((x) => x.goal)).toEqual(['theirs']);
  });

  it('cancel only cancels rows owned by the caller', () => {
    const mine = add({
      goal: 'mine',
      schedule: { kind: 'once', at: 100 },
      nextFireAt: 100,
      ownerUserId: 1,
    });
    const theirs = add({
      goal: 'theirs',
      schedule: { kind: 'once', at: 100 },
      nextFireAt: 100,
      ownerUserId: 2,
    });
    // User 2 cannot cancel user 1's action.
    expect(s.cancel(mine.id, 2)).toBe(false);
    expect(s.get(mine.id)?.status).toBe('active');
    // Owner can.
    expect(s.cancel(theirs.id, 2)).toBe(true);
    expect(s.get(theirs.id)?.status).toBe('cancelled');
  });

  it('listDue filters by next_fire_at <= now and status=active (all owners)', () => {
    add({ goal: 'past', schedule: { kind: 'once', at: 100 }, nextFireAt: 100, ownerUserId: 1 });
    add({ goal: 'other', schedule: { kind: 'once', at: 200 }, nextFireAt: 200, ownerUserId: 2 });
    add({ goal: 'future', schedule: { kind: 'once', at: 1000 }, nextFireAt: 1000 });
    expect(s.listDue(500).map((x) => x.goal)).toEqual(['past', 'other']);
  });

  it('listDue carries ownerUserId for delivery routing', () => {
    add({ goal: 'g', schedule: { kind: 'once', at: 100 }, nextFireAt: 100, ownerUserId: 3 });
    expect(s.listDue(500)[0]?.ownerUserId).toBe(3);
  });

  it('markFired with null nextFireAt marks done and stamps last_fired_at', () => {
    const x = add({
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
    const x = add({
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
    const x = add({
      goal: 'bad',
      schedule: { kind: 'once', at: 100 },
      nextFireAt: 100,
    });
    s.markError(x.id);
    const re = s.get(x.id);
    expect(re?.status).toBe('error');
  });

  it('markFired is a no-op on cancelled rows', () => {
    const x = add({
      goal: 'x',
      schedule: { kind: 'once', at: 100 },
      nextFireAt: 100,
    });
    s.cancel(x.id, 1);
    s.markFired(x.id, 200, null);
    const out = s.get(x.id);
    expect(out?.status).toBe('cancelled');
    expect(out?.lastFiredAt).toBeNull();
  });

  it('markError on a done row transitions to error (override path)', () => {
    const x = add({ goal: 'g', schedule: { kind: 'once', at: 100 }, nextFireAt: 100 });
    s.markFired(x.id, 200, null);
    expect(s.get(x.id)?.status).toBe('done');
    s.markError(x.id);
    expect(s.get(x.id)?.status).toBe('error');
  });

  it('markError is a no-op on cancelled rows', () => {
    const x = add({
      goal: 'x',
      schedule: { kind: 'once', at: 100 },
      nextFireAt: 100,
    });
    s.cancel(x.id, 1);
    s.markError(x.id);
    expect(s.get(x.id)?.status).toBe('cancelled');
  });

  it('cancel returns true on active and false on second call', () => {
    const x = add({
      goal: 'x',
      schedule: { kind: 'once', at: 100 },
      nextFireAt: 100,
    });
    expect(s.cancel(x.id, 1)).toBe(true);
    expect(s.cancel(x.id, 1)).toBe(false);
  });

  it('cancel non-existent id returns false', () => {
    expect(s.cancel(99999, 1)).toBe(false);
  });

  it('get on missing id returns null', () => {
    expect(s.get(99999)).toBeNull();
  });
});
