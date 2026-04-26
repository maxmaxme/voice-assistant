import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Scheduler } from '../../src/scheduling/scheduler.ts';
import type { RemindersAdapter, TimersAdapter, Reminder, Timer } from '../../src/memory/types.ts';
import type { DueItem } from '../../src/scheduling/types.ts';

function makeReminders(initial: Reminder[]): RemindersAdapter {
  const items = [...initial];
  return {
    add: () => {
      throw new Error('not used');
    },
    listPending: () => items.filter((i) => i.status === 'pending'),
    listDue: (now) => items.filter((i) => i.status === 'pending' && i.fireAt <= now),
    markFired: (id, at) => {
      const r = items.find((x) => x.id === id);
      if (r) {
        r.status = 'fired';
        r.firedAt = at;
      }
    },
    cancel: () => false,
    get: (id) => items.find((x) => x.id === id) ?? null,
  };
}

function makeTimers(initial: Timer[]): TimersAdapter {
  const items = [...initial];
  return {
    add: () => {
      throw new Error('not used');
    },
    listActive: () => items.filter((i) => i.status === 'active'),
    listDue: (now) => items.filter((i) => i.status === 'active' && i.fireAt <= now),
    markFired: (id, at) => {
      const t = items.find((x) => x.id === id);
      if (t) {
        t.status = 'fired';
        t.firedAt = at;
      }
    },
    cancel: () => false,
    get: (id) => items.find((x) => x.id === id) ?? null,
  };
}

describe('Scheduler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('fires due reminders and timers on each tick', async () => {
    vi.setSystemTime(2000);
    const fired: DueItem[] = [];
    const r = makeReminders([
      { id: 1, text: 'past', fireAt: 1000, status: 'pending', createdAt: 0, firedAt: null },
      { id: 2, text: 'future', fireAt: 5000, status: 'pending', createdAt: 0, firedAt: null },
    ]);
    const t = makeTimers([
      {
        id: 1,
        label: 'pasta',
        fireAt: 1500,
        durationMs: 1,
        status: 'active',
        createdAt: 0,
        firedAt: null,
      },
    ]);
    const s = new Scheduler({
      reminders: r,
      timers: t,
      sink: { fire: async (it) => void fired.push(it) },
      tickMs: 100,
    });
    s.start();
    await vi.advanceTimersByTimeAsync(150);
    s.stop();
    expect(fired.map((f) => f.kind).sort()).toEqual(['reminder', 'timer']);
    expect(r.listPending()).toHaveLength(1); // future left alone
  });

  it('does not fire the same reminder twice across ticks', async () => {
    vi.setSystemTime(5000);
    const fired: DueItem[] = [];
    const r = makeReminders([
      { id: 1, text: 'x', fireAt: 1000, status: 'pending', createdAt: 0, firedAt: null },
    ]);
    const t = makeTimers([]);
    const s = new Scheduler({
      reminders: r,
      timers: t,
      sink: { fire: async (it) => void fired.push(it) },
      tickMs: 100,
    });
    s.start();
    await vi.advanceTimersByTimeAsync(500);
    s.stop();
    expect(fired).toHaveLength(1);
  });

  it('does not mark fired if sink throws', async () => {
    vi.setSystemTime(5000);
    const r = makeReminders([
      { id: 1, text: 'x', fireAt: 1000, status: 'pending', createdAt: 0, firedAt: null },
    ]);
    const t = makeTimers([]);
    const s = new Scheduler({
      reminders: r,
      timers: t,
      sink: {
        fire: async () => {
          throw new Error('telegram down');
        },
      },
      tickMs: 100,
    });
    s.start();
    await vi.advanceTimersByTimeAsync(150);
    s.stop();
    expect(r.listPending()[0].id).toBe(1);
  });

  it('survives a thrown sink and continues firing other items', async () => {
    vi.setSystemTime(5000);
    const fired: DueItem[] = [];
    const r = makeReminders([
      { id: 1, text: 'a', fireAt: 1000, status: 'pending', createdAt: 0, firedAt: null },
      { id: 2, text: 'b', fireAt: 1100, status: 'pending', createdAt: 0, firedAt: null },
    ]);
    const t = makeTimers([]);
    let calls = 0;
    const s = new Scheduler({
      reminders: r,
      timers: t,
      sink: {
        fire: async (it) => {
          calls++;
          if (it.kind === 'reminder' && it.id === 1) {
            throw new Error('fail one');
          }
          fired.push(it);
        },
      },
      tickMs: 100,
    });
    s.start();
    await vi.advanceTimersByTimeAsync(150);
    s.stop();
    expect(calls).toBe(2);
    expect(fired.map((f) => (f.kind === 'reminder' ? f.id : -1))).toEqual([2]);
  });

  it('stop() halts ticks', async () => {
    vi.setSystemTime(5000);
    const fired: DueItem[] = [];
    const r = makeReminders([
      { id: 1, text: 'x', fireAt: 6000, status: 'pending', createdAt: 0, firedAt: null },
    ]);
    const t = makeTimers([]);
    const s = new Scheduler({
      reminders: r,
      timers: t,
      sink: { fire: async (it) => void fired.push(it) },
      tickMs: 100,
    });
    s.start();
    s.stop();
    vi.setSystemTime(7000);
    await vi.advanceTimersByTimeAsync(500);
    expect(fired).toHaveLength(0);
  });
});
