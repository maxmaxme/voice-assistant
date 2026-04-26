import { describe, it, expect, afterEach } from 'vitest';
import {
  SCHEDULED_ACTION_TOOL_NAMES,
  buildScheduledActionTools,
  executeScheduledActionTool,
} from '../../src/agent/scheduledActionTools.ts';
import type {
  NewScheduledAction,
  ScheduledAction,
  ScheduledActionsAdapter,
} from '../../src/memory/types.ts';
import { toLocalIso } from '../../src/utils/time.ts';

function memScheduled(): ScheduledActionsAdapter {
  let id = 0;
  const items: ScheduledAction[] = [];
  return {
    add: (input: NewScheduledAction) => {
      const r: ScheduledAction = {
        id: ++id,
        goal: input.goal,
        schedule: input.schedule,
        status: 'active',
        nextFireAt: input.nextFireAt,
        lastFiredAt: null,
        createdAt: Date.now(),
      };
      items.push(r);
      return r;
    },
    listActive: () =>
      items.filter((i) => i.status === 'active').sort((a, b) => a.nextFireAt - b.nextFireAt),
    listDue: (now) => items.filter((i) => i.status === 'active' && i.nextFireAt <= now),
    markFired: (id, at, nextFireAt) => {
      const r = items.find((x) => x.id === id);
      if (!r) {
        return;
      }
      if (nextFireAt === null) {
        r.status = 'done';
        r.lastFiredAt = at;
      } else {
        r.nextFireAt = nextFireAt;
        r.lastFiredAt = at;
      }
    },
    markError: (id) => {
      const r = items.find((x) => x.id === id);
      if (r) {
        r.status = 'error';
      }
    },
    cancel: (id) => {
      const r = items.find((x) => x.id === id && x.status === 'active');
      if (!r) {
        return false;
      }
      r.status = 'cancelled';
      return true;
    },
    get: (id) => items.find((x) => x.id === id) ?? null,
  };
}

describe('scheduledActionTools — surface', () => {
  it('exposes the three tool names', () => {
    expect(SCHEDULED_ACTION_TOOL_NAMES).toEqual(
      new Set(['schedule_action', 'list_scheduled', 'cancel_scheduled']),
    );
  });

  it('schedule_action schema requires goal/schedule_kind/schedule_expr and is strict', () => {
    const tools = buildScheduledActionTools();
    const schedule = tools.find((t) => t.name === 'schedule_action')!;
    expect(schedule.parameters).toMatchObject({
      required: expect.arrayContaining(['goal', 'schedule_kind', 'schedule_expr']),
      additionalProperties: false,
    });
  });

  it('cancel_scheduled requires id', () => {
    const tools = buildScheduledActionTools();
    const cancel = tools.find((t) => t.name === 'cancel_scheduled')!;
    expect(cancel.parameters).toMatchObject({ required: ['id'] });
  });

  it('throws for unknown tool name', () => {
    const a = memScheduled();
    expect(() => executeScheduledActionTool(a, 'whatever', {})).toThrow(/unknown/i);
  });
});

describe('scheduledActionTools — schedule_action once', () => {
  const originalTz = process.env.TZ;
  afterEach(() => {
    if (originalTz === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = originalTz;
    }
  });

  it('happy path: parses wall-clock under server TZ', () => {
    process.env.TZ = 'Europe/Madrid';
    const a = memScheduled();
    const out = executeScheduledActionTool(a, 'schedule_action', {
      goal: 'Включи свет на кухне',
      schedule_kind: 'once',
      schedule_expr: '2099-06-15 09:00',
    });
    // 2099-06-15 09:00 Europe/Madrid (CEST = UTC+2 in summer) = 07:00:00Z
    expect(out.next_fire_at).toBe(Date.UTC(2099, 5, 15, 7, 0, 0));
    expect(out.schedule_kind).toBe('once');
    expect(out.schedule_expr).toBe(String(Date.UTC(2099, 5, 15, 7, 0, 0)));
    expect(out.goal).toBe('Включи свет на кухне');
    expect(out.id).toBe(1);
    expect(out.next_fire_at_local).toContain('2099-06-15');
  });

  it('rejects past schedule_expr', () => {
    process.env.TZ = 'UTC';
    const a = memScheduled();
    expect(() =>
      executeScheduledActionTool(a, 'schedule_action', {
        goal: 'x',
        schedule_kind: 'once',
        schedule_expr: '2020-01-01 00:00',
      }),
    ).toThrow(/past/i);
  });

  it('rejects malformed schedule_expr and includes the bad value', () => {
    const a = memScheduled();
    expect(() =>
      executeScheduledActionTool(a, 'schedule_action', {
        goal: 'x',
        schedule_kind: 'once',
        schedule_expr: 'tomorrow morning',
      }),
    ).toThrow(/tomorrow morning/);
  });

  it('rejects empty goal', () => {
    const a = memScheduled();
    expect(() =>
      executeScheduledActionTool(a, 'schedule_action', {
        goal: '   ',
        schedule_kind: 'once',
        schedule_expr: '2099-06-15 09:00',
      }),
    ).toThrow(/goal/);
  });
});

describe('scheduledActionTools — schedule_action cron', () => {
  const originalTz = process.env.TZ;
  afterEach(() => {
    if (originalTz === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = originalTz;
    }
  });

  it('happy path: computes future next_fire_at for daily 08:00', () => {
    process.env.TZ = 'Europe/Madrid';
    const a = memScheduled();
    const out = executeScheduledActionTool(a, 'schedule_action', {
      goal: 'утренний свет',
      schedule_kind: 'cron',
      schedule_expr: '0 8 * * *',
    });
    expect(out.schedule_kind).toBe('cron');
    expect(out.schedule_expr).toBe('0 8 * * *');
    expect(out.next_fire_at).toBeGreaterThan(Date.now());
    // Local string should land on 08:00 Madrid (today or tomorrow).
    expect(out.next_fire_at_local).toContain('08:00');
  });

  it('rejects an invalid cron expression', () => {
    const a = memScheduled();
    expect(() =>
      executeScheduledActionTool(a, 'schedule_action', {
        goal: 'x',
        schedule_kind: 'cron',
        schedule_expr: 'not a cron',
      }),
    ).toThrow(/cron|not a cron/i);
  });
});

describe('scheduledActionTools — unknown schedule_kind', () => {
  it('throws with a clear message', () => {
    const a = memScheduled();
    expect(() =>
      executeScheduledActionTool(a, 'schedule_action', {
        goal: 'x',
        schedule_kind: 'monthly',
        schedule_expr: '0 8 1 * *',
      }),
    ).toThrow(/schedule_kind/);
  });
});

describe('scheduledActionTools — list_scheduled', () => {
  it('returns empty list when nothing is scheduled', () => {
    const a = memScheduled();
    expect(executeScheduledActionTool(a, 'list_scheduled', {})).toEqual([]);
  });

  it('returns active rows with both _local fields populated', () => {
    const a = memScheduled();
    const future = Date.now() + 60_000;
    a.add({ goal: 'g1', schedule: { kind: 'once', at: future }, nextFireAt: future });
    const out = executeScheduledActionTool(a, 'list_scheduled', {});
    expect(out).toHaveLength(1);
    expect(out[0].goal).toBe('g1');
    expect(out[0].next_fire_at_local).toBe(toLocalIso(future));
    expect(out[0].last_fired_at).toBeNull();
    expect(out[0].last_fired_at_local).toBeNull();
  });

  it('skips cancelled / done rows', () => {
    const a = memScheduled();
    const t1 = Date.now() + 60_000;
    const t2 = Date.now() + 120_000;
    const r1 = a.add({ goal: 'g1', schedule: { kind: 'once', at: t1 }, nextFireAt: t1 });
    a.add({ goal: 'g2', schedule: { kind: 'once', at: t2 }, nextFireAt: t2 });
    a.cancel(r1.id);
    const out = executeScheduledActionTool(a, 'list_scheduled', {});
    expect(out).toHaveLength(1);
    expect(out[0].goal).toBe('g2');
  });
});

describe('scheduledActionTools — cancel_scheduled', () => {
  it('returns ok:true then ok:false for double-cancel', () => {
    const a = memScheduled();
    const t = Date.now() + 60_000;
    const r = a.add({ goal: 'g', schedule: { kind: 'once', at: t }, nextFireAt: t });
    expect(executeScheduledActionTool(a, 'cancel_scheduled', { id: r.id })).toEqual({ ok: true });
    expect(executeScheduledActionTool(a, 'cancel_scheduled', { id: r.id })).toEqual({ ok: false });
  });

  it('returns ok:false for unknown id', () => {
    const a = memScheduled();
    expect(executeScheduledActionTool(a, 'cancel_scheduled', { id: 99999 })).toEqual({ ok: false });
  });
});
