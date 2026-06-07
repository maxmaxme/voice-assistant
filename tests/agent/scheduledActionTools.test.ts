import { describe, it, expect, afterEach } from 'vitest';
import {
  SCHEDULED_ACTION_TOOL_NAMES,
  buildScheduledActionTools,
  executeScheduledActionTool,
  type ScheduledActionToolContext,
} from '../../src/agent/scheduledActionTools.ts';
import type {
  Channel,
  IdentitiesAdapter,
  NewScheduledAction,
  ScheduledAction,
  ScheduledActionsAdapter,
} from '../../src/memory/types.ts';
import { toLocalIso } from '../../src/utils/time.ts';
import { assertError } from '../../src/utils/assertError.ts';

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
        ownerUserId: input.ownerUserId,
      };
      items.push(r);
      return r;
    },
    listActiveForOwner: (userId) =>
      items
        .filter((i) => i.status === 'active' && i.ownerUserId === userId)
        .sort((a, b) => a.nextFireAt - b.nextFireAt),
    listDue: (now) => items.filter((i) => i.status === 'active' && i.nextFireAt <= now),
    markFired: (id, at, nextFireAt) => {
      const r = items.find((x) => x.id === id);
      if (!r || r.status !== 'active') {
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
      if (r && (r.status === 'active' || r.status === 'done')) {
        r.status = 'error';
      }
    },
    cancel: (id, userId) => {
      const r = items.find((x) => x.id === id && x.ownerUserId === userId && x.status === 'active');
      if (!r) {
        return false;
      }
      r.status = 'cancelled';
      return true;
    },
    get: (id) => items.find((x) => x.id === id) ?? null,
  };
}

function fakeIdentities(telegramByUser: Record<number, string>): IdentitiesAdapter {
  return {
    resolve: () => null,
    touch: () => {},
    identityFor: (channel: Channel, userId: number) =>
      channel === 'telegram' ? (telegramByUser[userId] ?? null) : null,
    listTelegramUsers: () =>
      Object.entries(telegramByUser).map(([userId, chatId]) => ({
        userId: Number(userId),
        name: `user${userId}`,
        chatId,
      })),
    addUser: () => 0,
    attachIdentity: () => {},
    isAdmin: () => false,
    setAdmin: () => {},
    isEmpty: () => false,
  };
}

// Default context: an identified user (1) who has a Telegram chat to deliver to.
const ctx = (): ScheduledActionToolContext => ({
  ownerUserId: 1,
  identities: fakeIdentities({ 1: '555' }),
});

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
    expect(() => executeScheduledActionTool(a, 'whatever', {}, ctx())).toThrow(/unknown/i);
  });
});

describe('scheduledActionTools — ownership / delivery preconditions', () => {
  it('schedule_action refuses when there is no current user and no recipient', () => {
    const a = memScheduled();
    expect(() =>
      executeScheduledActionTool(
        a,
        'schedule_action',
        { goal: 'x', schedule_kind: 'once', schedule_expr: '2099-06-15 09:00' },
        { ownerUserId: null, identities: fakeIdentities({ 1: '555' }) },
      ),
    ).toThrow(/no recipient|no current user/i);
  });

  it('schedule_action refuses when the current user has no Telegram linked', () => {
    const a = memScheduled();
    expect(() =>
      executeScheduledActionTool(
        a,
        'schedule_action',
        { goal: 'x', schedule_kind: 'once', schedule_expr: '2099-06-15 09:00' },
        { ownerUserId: 2, identities: fakeIdentities({ 1: '555' }) }, // user 2 has none
      ),
    ).toThrow(/Telegram/i);
  });

  it('schedule_action stores the caller as owner by default', () => {
    const a = memScheduled();
    const out = executeScheduledActionTool(
      a,
      'schedule_action',
      { goal: 'x', schedule_kind: 'once', schedule_expr: '2099-06-15 09:00' },
      ctx(),
    );
    expect(a.get(out.id)?.ownerUserId).toBe(1);
  });

  it('schedule_action sets owner = explicit recipient', () => {
    const a = memScheduled();
    const out = executeScheduledActionTool(
      a,
      'schedule_action',
      { goal: 'x', schedule_kind: 'once', schedule_expr: '2099-06-15 09:00', recipient: 2 },
      { ownerUserId: 1, identities: fakeIdentities({ 1: '555', 2: '999' }) },
    );
    expect(a.get(out.id)?.ownerUserId).toBe(2);
  });

  it('schedule_action refuses a recipient with no Telegram (even if the caller has one)', () => {
    const a = memScheduled();
    expect(() =>
      executeScheduledActionTool(
        a,
        'schedule_action',
        { goal: 'x', schedule_kind: 'once', schedule_expr: '2099-06-15 09:00', recipient: 3 },
        { ownerUserId: 1, identities: fakeIdentities({ 1: '555' }) },
      ),
    ).toThrow(/Telegram/i);
  });

  it('list_scheduled is scoped to the caller', () => {
    const a = memScheduled();
    const future = Date.now() + 60_000;
    a.add({
      goal: 'mine',
      schedule: { kind: 'once', at: future },
      nextFireAt: future,
      ownerUserId: 1,
    });
    a.add({
      goal: 'theirs',
      schedule: { kind: 'once', at: future },
      nextFireAt: future,
      ownerUserId: 2,
    });
    const out = executeScheduledActionTool(a, 'list_scheduled', {}, ctx());
    expect(out.map((x) => x.goal)).toEqual(['mine']);
  });

  it('list_scheduled returns empty for an unidentified caller', () => {
    const a = memScheduled();
    const future = Date.now() + 60_000;
    a.add({
      goal: 'g',
      schedule: { kind: 'once', at: future },
      nextFireAt: future,
      ownerUserId: 1,
    });
    expect(
      executeScheduledActionTool(
        a,
        'list_scheduled',
        {},
        {
          ownerUserId: null,
          identities: fakeIdentities({}),
        },
      ),
    ).toEqual([]);
  });

  it('cancel_scheduled cannot cancel another user’s action', () => {
    const a = memScheduled();
    const future = Date.now() + 60_000;
    const theirs = a.add({
      goal: 'theirs',
      schedule: { kind: 'once', at: future },
      nextFireAt: future,
      ownerUserId: 2,
    });
    expect(executeScheduledActionTool(a, 'cancel_scheduled', { id: theirs.id }, ctx())).toEqual({
      ok: false,
    });
    expect(a.get(theirs.id)?.status).toBe('active');
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
    const out = executeScheduledActionTool(
      a,
      'schedule_action',
      {
        goal: 'Turn on the kitchen light',
        schedule_kind: 'once',
        schedule_expr: '2099-06-15 09:00',
      },
      ctx(),
    );
    // 2099-06-15 09:00 Europe/Madrid (CEST = UTC+2 in summer) = 07:00:00Z
    expect(out.next_fire_at).toBe(Date.UTC(2099, 5, 15, 7, 0, 0));
    expect(out.schedule_kind).toBe('once');
    expect(out.schedule_expr).toBe(toLocalIso(Date.UTC(2099, 5, 15, 7, 0, 0)));
    expect(out.goal).toBe('Turn on the kitchen light');
    expect(out.id).toBe(1);
    expect(out.next_fire_at_local).toContain('2099-06-15');
  });

  it('rejects past schedule_expr', () => {
    process.env.TZ = 'UTC';
    const a = memScheduled();
    expect(() =>
      executeScheduledActionTool(
        a,
        'schedule_action',
        { goal: 'x', schedule_kind: 'once', schedule_expr: '2020-01-01 00:00' },
        ctx(),
      ),
    ).toThrow(/past/i);
  });

  it('past-rejection error message includes a "now" anchor', () => {
    process.env.TZ = 'UTC';
    const a = memScheduled();
    expect(() =>
      executeScheduledActionTool(
        a,
        'schedule_action',
        { goal: 'x', schedule_kind: 'once', schedule_expr: '2020-01-01 00:00' },
        ctx(),
      ),
    ).toThrow(/now: \d{4}-\d{2}-\d{2}/);
  });

  it('rejects malformed schedule_expr and includes the bad value', () => {
    const a = memScheduled();
    expect(() =>
      executeScheduledActionTool(
        a,
        'schedule_action',
        { goal: 'x', schedule_kind: 'once', schedule_expr: 'tomorrow morning' },
        ctx(),
      ),
    ).toThrow(/tomorrow morning/);
  });

  it('rejects empty goal', () => {
    const a = memScheduled();
    expect(() =>
      executeScheduledActionTool(
        a,
        'schedule_action',
        { goal: '   ', schedule_kind: 'once', schedule_expr: '2099-06-15 09:00' },
        ctx(),
      ),
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
    const out = executeScheduledActionTool(
      a,
      'schedule_action',
      { goal: 'morning light', schedule_kind: 'cron', schedule_expr: '0 8 * * *' },
      ctx(),
    );
    expect(out.schedule_kind).toBe('cron');
    expect(out.schedule_expr).toBe('0 8 * * *');
    expect(out.next_fire_at).toBeGreaterThan(Date.now());
    // Local string should land on 08:00 Madrid (today or tomorrow).
    expect(out.next_fire_at_local).toContain('08:00');
  });

  it('rejects an invalid cron expression', () => {
    const a = memScheduled();
    expect(() =>
      executeScheduledActionTool(
        a,
        'schedule_action',
        { goal: 'x', schedule_kind: 'cron', schedule_expr: 'not a cron' },
        ctx(),
      ),
    ).toThrow(/cron|not a cron/i);
  });

  it('cron error message includes a worked example', () => {
    const a = memScheduled();
    let err: Error | undefined;
    try {
      executeScheduledActionTool(
        a,
        'schedule_action',
        { goal: 'x', schedule_kind: 'cron', schedule_expr: 'not a cron' },
        ctx(),
      );
    } catch (e) {
      assertError(e);
      err = e;
    }
    expect(err).toBeDefined();
    expect(err!.message).toMatch(/cron/);
    expect(err!.message).toMatch(/0 8 \* \* \*/);
  });
});

describe('scheduledActionTools — unknown schedule_kind', () => {
  it('throws with a clear message', () => {
    const a = memScheduled();
    expect(() =>
      executeScheduledActionTool(
        a,
        'schedule_action',
        { goal: 'x', schedule_kind: 'monthly', schedule_expr: '0 8 1 * *' },
        ctx(),
      ),
    ).toThrow(/schedule_kind/);
  });
});

describe('scheduledActionTools — list_scheduled', () => {
  it('returns empty list when nothing is scheduled', () => {
    const a = memScheduled();
    expect(executeScheduledActionTool(a, 'list_scheduled', {}, ctx())).toEqual([]);
  });

  it('returns active rows with both _local fields populated', () => {
    const a = memScheduled();
    const future = Date.now() + 60_000;
    a.add({
      goal: 'g1',
      schedule: { kind: 'once', at: future },
      nextFireAt: future,
      ownerUserId: 1,
    });
    const out = executeScheduledActionTool(a, 'list_scheduled', {}, ctx());
    expect(out).toHaveLength(1);
    expect(out[0].goal).toBe('g1');
    expect(out[0].next_fire_at_local).toBe(toLocalIso(future));
    expect(out[0].last_fired_at).toBeNull();
    expect(out[0].last_fired_at_local).toBeNull();
  });

  it('sorts rows by next_fire_at ascending regardless of insertion order', () => {
    const a = memScheduled();
    const t1 = Date.now() + 60_000;
    const t2 = Date.now() + 120_000;
    // Insert later first, earlier second.
    a.add({ goal: 'g2', schedule: { kind: 'once', at: t2 }, nextFireAt: t2, ownerUserId: 1 });
    a.add({ goal: 'g1', schedule: { kind: 'once', at: t1 }, nextFireAt: t1, ownerUserId: 1 });
    const out = executeScheduledActionTool(a, 'list_scheduled', {}, ctx());
    expect(out).toHaveLength(2);
    expect(out[0].goal).toBe('g1');
    expect(out[1].goal).toBe('g2');
  });

  it('skips cancelled / done rows', () => {
    const a = memScheduled();
    const t1 = Date.now() + 60_000;
    const t2 = Date.now() + 120_000;
    const r1 = a.add({
      goal: 'g1',
      schedule: { kind: 'once', at: t1 },
      nextFireAt: t1,
      ownerUserId: 1,
    });
    a.add({ goal: 'g2', schedule: { kind: 'once', at: t2 }, nextFireAt: t2, ownerUserId: 1 });
    a.cancel(r1.id, 1);
    const out = executeScheduledActionTool(a, 'list_scheduled', {}, ctx());
    expect(out).toHaveLength(1);
    expect(out[0].goal).toBe('g2');
  });
});

describe('scheduledActionTools — cancel_scheduled', () => {
  it('returns ok:true then ok:false for double-cancel', () => {
    const a = memScheduled();
    const t = Date.now() + 60_000;
    const r = a.add({
      goal: 'g',
      schedule: { kind: 'once', at: t },
      nextFireAt: t,
      ownerUserId: 1,
    });
    expect(executeScheduledActionTool(a, 'cancel_scheduled', { id: r.id }, ctx())).toEqual({
      ok: true,
    });
    expect(executeScheduledActionTool(a, 'cancel_scheduled', { id: r.id }, ctx())).toEqual({
      ok: false,
    });
  });

  it('returns ok:false for unknown id', () => {
    const a = memScheduled();
    expect(executeScheduledActionTool(a, 'cancel_scheduled', { id: 99999 }, ctx())).toEqual({
      ok: false,
    });
  });
});
