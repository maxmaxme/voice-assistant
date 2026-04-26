import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Scheduler } from '../../src/scheduling/scheduler.ts';
import type { ScheduledAction, ScheduledActionsAdapter } from '../../src/memory/types.ts';
import type { GoalRunner } from '../../src/scheduling/goalRunner.ts';
import { nextFireAt as computeNextFireAt } from '../../src/scheduling/cron.ts';

function makeAdapter(initial: ScheduledAction[]): ScheduledActionsAdapter & {
  rows: ScheduledAction[];
} {
  const rows = initial.map((r) => ({ ...r }));
  return {
    rows,
    add: (): ScheduledAction => {
      throw new Error('not used');
    },
    listActive: () => rows.filter((r) => r.status === 'active'),
    listDue: (now: number) =>
      rows
        .filter((r) => r.status === 'active' && r.nextFireAt <= now)
        .sort((a, b) => a.nextFireAt - b.nextFireAt),
    markFired: (id: number, at: number, next: number | null) => {
      const r = rows.find((x) => x.id === id);
      if (!r || r.status !== 'active') {
        return;
      }
      r.lastFiredAt = at;
      if (next === null) {
        r.status = 'done';
      } else {
        r.nextFireAt = next;
      }
    },
    markError: (id: number) => {
      const r = rows.find((x) => x.id === id);
      if (r && (r.status === 'active' || r.status === 'done')) {
        r.status = 'error';
      }
    },
    cancel: (id: number) => {
      const r = rows.find((x) => x.id === id);
      if (!r) {
        return false;
      }
      r.status = 'cancelled';
      return true;
    },
    get: (id: number) => rows.find((x) => x.id === id) ?? null,
  };
}

function makeGoalRunner(impl?: (goal: string) => Promise<void>): GoalRunner & {
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    fire: async (goal: string): Promise<void> => {
      calls.push(goal);
      if (impl) {
        await impl(goal);
      }
    },
  };
}

function onceRow(over: Partial<ScheduledAction> = {}): ScheduledAction {
  return {
    id: 1,
    goal: 'remind me water plants',
    schedule: { kind: 'once', at: 1000 },
    status: 'active',
    nextFireAt: 1000,
    lastFiredAt: null,
    createdAt: 0,
    ...over,
  };
}

function cronRow(over: Partial<ScheduledAction> = {}): ScheduledAction {
  return {
    id: 2,
    goal: 'morning briefing',
    schedule: { kind: 'cron', expr: '0 8 * * *' },
    status: 'active',
    nextFireAt: 1000,
    lastFiredAt: null,
    createdAt: 0,
    ...over,
  };
}

describe('Scheduler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('fires a due once-row and marks it done', async () => {
    const adapter = makeAdapter([onceRow({ nextFireAt: 500 })]);
    const goalRunner = makeGoalRunner();
    const s = new Scheduler({
      scheduledActions: adapter,
      goalRunner,
      tickMs: 100,
      now: () => 2000,
    });
    s.start();
    await s.tick();
    s.stop();
    expect(goalRunner.calls).toEqual(['remind me water plants']);
    expect(adapter.rows[0].status).toBe('done');
    expect(adapter.rows[0].lastFiredAt).toBe(2000);
  });

  it('fires a due cron-row and advances nextFireAt; status stays active', async () => {
    const now = Date.UTC(2026, 3, 26, 6, 0, 0); // some fixed UTC instant
    const cron = cronRow({ nextFireAt: now - 1000 });
    const adapter = makeAdapter([cron]);
    const goalRunner = makeGoalRunner();
    const s = new Scheduler({
      scheduledActions: adapter,
      goalRunner,
      tickMs: 100,
      now: () => now,
    });
    s.start();
    await s.tick();
    s.stop();
    expect(goalRunner.calls).toHaveLength(1);
    expect(adapter.rows[0].status).toBe('active');
    expect(adapter.rows[0].nextFireAt).toBeGreaterThan(now);
    // sanity: matches cron utility
    const expected = computeNextFireAt({ kind: 'cron', expr: '0 8 * * *' }, now);
    expect(adapter.rows[0].nextFireAt).toBe(expected);
  });

  it('cron throw leaves status active; nextFireAt advanced; logs to stderr', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const now = Date.UTC(2026, 3, 26, 6, 0, 0);
    const adapter = makeAdapter([cronRow({ nextFireAt: now - 1000 })]);
    const goalRunner = makeGoalRunner(async () => {
      throw new Error('agent boom');
    });
    const s = new Scheduler({
      scheduledActions: adapter,
      goalRunner,
      tickMs: 100,
      now: () => now,
    });
    s.start();
    await s.tick();
    s.stop();
    expect(adapter.rows[0].status).toBe('active');
    expect(adapter.rows[0].nextFireAt).toBeGreaterThan(now);
    const calls = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(calls).toMatch(/action 2 fire failed: agent boom/);
    stderr.mockRestore();
  });

  it('once throw flips status to error', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const adapter = makeAdapter([onceRow({ nextFireAt: 500 })]);
    const goalRunner = makeGoalRunner(async () => {
      throw new Error('nope');
    });
    const s = new Scheduler({
      scheduledActions: adapter,
      goalRunner,
      tickMs: 100,
      now: () => 1000,
    });
    s.start();
    await s.tick();
    s.stop();
    expect(adapter.rows[0].status).toBe('error');
    stderr.mockRestore();
  });

  it('fires multiple due rows in listDue ascending order', async () => {
    const adapter = makeAdapter([
      onceRow({ id: 10, goal: 'second', nextFireAt: 900 }),
      onceRow({ id: 11, goal: 'first', nextFireAt: 500 }),
    ]);
    const goalRunner = makeGoalRunner();
    const s = new Scheduler({
      scheduledActions: adapter,
      goalRunner,
      tickMs: 100,
      now: () => 1000,
    });
    s.start();
    await s.tick();
    s.stop();
    expect(goalRunner.calls).toEqual(['first', 'second']);
  });

  it('listDue throwing bails the tick; no fires; logs to stderr', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const goalRunner = makeGoalRunner();
    const broken: ScheduledActionsAdapter = {
      add: () => {
        throw new Error('not used');
      },
      listActive: () => [],
      listDue: () => {
        throw new Error('db gone');
      },
      markFired: () => {},
      markError: () => {},
      cancel: () => false,
      get: () => null,
    };
    const s = new Scheduler({
      scheduledActions: broken,
      goalRunner,
      tickMs: 100,
      now: () => 1000,
    });
    s.start();
    await expect(s.tick()).resolves.toBeUndefined();
    s.stop();
    expect(goalRunner.calls).toEqual([]);
    const calls = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(calls).toMatch(/listDue failed: db gone/);
    stderr.mockRestore();
  });

  it('tick() is a no-op when the scheduler is not running', async () => {
    const adapter = makeAdapter([onceRow({ nextFireAt: 500 })]);
    const goalRunner = makeGoalRunner();
    const s = new Scheduler({
      scheduledActions: adapter,
      goalRunner,
      tickMs: 100,
      now: () => 1000,
    });
    // Never started.
    await s.tick();
    expect(goalRunner.calls).toEqual([]);
    // Started then stopped.
    s.start();
    s.stop();
    await s.tick();
    expect(goalRunner.calls).toEqual([]);
  });

  it('start() is idempotent — no double interval', async () => {
    vi.setSystemTime(0);
    const adapter = makeAdapter([onceRow({ nextFireAt: 0 })]);
    const goalRunner = makeGoalRunner();
    const s = new Scheduler({
      scheduledActions: adapter,
      goalRunner,
      tickMs: 100,
      now: () => 1000,
    });
    s.start();
    s.start();
    await vi.advanceTimersByTimeAsync(150);
    s.stop();
    // Only one interval scheduled, so only one tick fired the row before
    // it was marked done.
    expect(goalRunner.calls).toHaveLength(1);
  });

  it('stop() clears the interval cleanly — no further ticks fire', async () => {
    vi.setSystemTime(0);
    const adapter = makeAdapter([onceRow({ nextFireAt: 0 })]);
    const goalRunner = makeGoalRunner();
    const s = new Scheduler({
      scheduledActions: adapter,
      goalRunner,
      tickMs: 100,
      now: () => 1000,
    });
    s.start();
    s.stop();
    await vi.advanceTimersByTimeAsync(500);
    expect(goalRunner.calls).toEqual([]);
  });
});
