import { describe, it, expect } from 'vitest';
import { TIMER_TOOL_NAMES, buildTimerTools, executeTimerTool } from '../../src/agent/timerTools.ts';
import type { TimersAdapter, Timer } from '../../src/memory/types.ts';

function memTimers(): TimersAdapter {
  let id = 0;
  const items: Timer[] = [];
  return {
    add: ({ label, fireAt, durationMs }) => {
      const t: Timer = {
        id: ++id,
        label,
        fireAt,
        durationMs,
        status: 'active',
        createdAt: Date.now(),
        firedAt: null,
      };
      items.push(t);
      return t;
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
    cancel: (id) => {
      const t = items.find((x) => x.id === id && x.status === 'active');
      if (!t) return false;
      t.status = 'cancelled';
      return true;
    },
    get: (id) => items.find((x) => x.id === id) ?? null,
  };
}

describe('timerTools', () => {
  it('exposes 3 tool names', () => {
    expect(TIMER_TOOL_NAMES).toEqual(new Set(['set_timer', 'list_timers', 'cancel_timer']));
  });

  it('build returns tool definitions', () => {
    const tools = buildTimerTools();
    const set = tools.find((t) => t.name === 'set_timer')!;
    expect(set.parameters).toMatchObject({
      required: expect.arrayContaining(['label', 'seconds']),
    });
  });

  it('set_timer creates a timer firing at now+seconds*1000', () => {
    const t = memTimers();
    const before = Date.now();
    const out = executeTimerTool(t, 'set_timer', { label: 'pasta', seconds: 60 });
    expect(out.id).toBe(1);
    expect(out.fire_at).toBeGreaterThanOrEqual(before + 60_000);
    expect(out.fire_at).toBeLessThanOrEqual(Date.now() + 60_000 + 100);
    expect(t.listActive()[0].label).toBe('pasta');
  });

  it('set_timer rejects non-positive seconds', () => {
    const t = memTimers();
    expect(() => executeTimerTool(t, 'set_timer', { label: 'x', seconds: 0 })).toThrow();
    expect(() => executeTimerTool(t, 'set_timer', { label: 'x', seconds: -3 })).toThrow();
  });

  it('list_timers returns active', () => {
    const t = memTimers();
    t.add({ label: 'a', fireAt: 100, durationMs: 100 });
    const out = executeTimerTool(t, 'list_timers', {});
    expect(out.length).toBe(1);
  });

  it('cancel_timer round-trip', () => {
    const t = memTimers();
    const x = t.add({ label: 'a', fireAt: 100, durationMs: 100 });
    expect(executeTimerTool(t, 'cancel_timer', { id: x.id })).toEqual({ ok: true });
    expect(executeTimerTool(t, 'cancel_timer', { id: x.id })).toEqual({ ok: false });
  });

  it('throws for unknown tool name', () => {
    const t = memTimers();
    expect(() => executeTimerTool(t, 'nope', {})).toThrow(/unknown/i);
  });
});
