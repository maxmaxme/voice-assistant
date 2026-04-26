import { describe, it, expect, afterEach } from 'vitest';
import {
  REMINDER_TOOL_NAMES,
  buildReminderTools,
  executeReminderTool,
} from '../../src/agent/reminderTools.ts';
import type { RemindersAdapter, Reminder } from '../../src/memory/types.ts';

function memReminders(): RemindersAdapter {
  let id = 0;
  const items: Reminder[] = [];
  return {
    add: ({ text, fireAt }) => {
      const r: Reminder = {
        id: ++id,
        text,
        fireAt,
        status: 'pending',
        createdAt: Date.now(),
        firedAt: null,
      };
      items.push(r);
      return r;
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
    cancel: (id) => {
      const r = items.find((x) => x.id === id && x.status === 'pending');
      if (!r) return false;
      r.status = 'cancelled';
      return true;
    },
    get: (id) => items.find((x) => x.id === id) ?? null,
  };
}

describe('reminderTools', () => {
  it('exposes 3 tool names', () => {
    expect(REMINDER_TOOL_NAMES).toEqual(
      new Set(['add_reminder', 'list_reminders', 'cancel_reminder']),
    );
  });

  it('build returns tool definitions with required params', () => {
    const tools = buildReminderTools();
    const add = tools.find((t) => t.name === 'add_reminder')!;
    expect(add.parameters).toMatchObject({
      required: expect.arrayContaining(['text', 'in_seconds', 'at_local', 'fire_at']),
    });
  });

  it('add_reminder writes to the adapter and returns the id (fire_at form)', () => {
    const r = memReminders();
    const out = executeReminderTool(r, 'add_reminder', {
      text: 'X',
      fire_at: Date.now() + 60_000,
      in_seconds: null,
      at_local: null,
    });
    expect(out.id).toBe(1);
    expect(r.listPending()).toHaveLength(1);
  });

  it('add_reminder accepts in_seconds (relative) and computes fire_at server-side', () => {
    const r = memReminders();
    const before = Date.now();
    const out = executeReminderTool(r, 'add_reminder', {
      text: 'call mom',
      in_seconds: 3600,
      at_local: null,
      fire_at: null,
    });
    expect(out.fire_at).toBeGreaterThanOrEqual(before + 3600_000);
    expect(out.fire_at).toBeLessThanOrEqual(Date.now() + 3600_000 + 100);
  });

  it('add_reminder rejects non-positive in_seconds', () => {
    const r = memReminders();
    expect(() =>
      executeReminderTool(r, 'add_reminder', {
        text: 'X',
        in_seconds: 0,
        at_local: null,
        fire_at: null,
      }),
    ).toThrow(/in_seconds/);
    expect(() =>
      executeReminderTool(r, 'add_reminder', {
        text: 'X',
        in_seconds: -10,
        at_local: null,
        fire_at: null,
      }),
    ).toThrow(/in_seconds/);
  });

  it('add_reminder accepts at_local as a wall-clock string in the server TZ', () => {
    const originalTz = process.env.TZ;
    process.env.TZ = 'Europe/Madrid';
    try {
      const r = memReminders();
      // Pick a date far in the future so it is unambiguously in the future
      // regardless of when this test runs.
      const out = executeReminderTool(r, 'add_reminder', {
        text: 'meeting',
        at_local: '2099-06-15 09:00:00',
        in_seconds: null,
        fire_at: null,
      });
      // 2099-06-15 09:00 in Europe/Madrid (CEST = UTC+2 in summer) = 07:00:00Z
      expect(out.fire_at).toBe(Date.UTC(2099, 5, 15, 7, 0, 0));
    } finally {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    }
  });

  it('add_reminder rejects malformed at_local strings', () => {
    const r = memReminders();
    expect(() =>
      executeReminderTool(r, 'add_reminder', {
        text: 'X',
        at_local: 'tomorrow at 9am',
        in_seconds: null,
        fire_at: null,
      }),
    ).toThrow(/at_local/);
  });

  it('add_reminder requires exactly one of in_seconds/at_local/fire_at', () => {
    const r = memReminders();
    // None provided
    expect(() =>
      executeReminderTool(r, 'add_reminder', {
        text: 'X',
        in_seconds: null,
        at_local: null,
        fire_at: null,
      }),
    ).toThrow(/one of/);
    // Two provided
    expect(() =>
      executeReminderTool(r, 'add_reminder', {
        text: 'X',
        in_seconds: 60,
        at_local: null,
        fire_at: Date.now() + 60_000,
      }),
    ).toThrow(/only one/);
  });

  it('add_reminder rejects fire_at in the past with a clear error', () => {
    const r = memReminders();
    expect(() =>
      executeReminderTool(r, 'add_reminder', {
        text: 'X',
        fire_at: Date.now() - 60_000,
        in_seconds: null,
        at_local: null,
      }),
    ).toThrow(/past/i);
  });

  it('list_reminders returns pending only', () => {
    const r = memReminders();
    r.add({ text: 'a', fireAt: Date.now() + 100_000 });
    const fired = r.add({ text: 'b', fireAt: 50 });
    r.markFired(fired.id, 50);
    const out = executeReminderTool(r, 'list_reminders', {});
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe('a');
  });

  it('cancel_reminder returns ok:true on success and ok:false on missing', () => {
    const r = memReminders();
    const x = r.add({ text: 'a', fireAt: 100 });
    expect(executeReminderTool(r, 'cancel_reminder', { id: x.id })).toEqual({ ok: true });
    expect(executeReminderTool(r, 'cancel_reminder', { id: 99999 })).toEqual({ ok: false });
  });

  it('throws for unknown tool name', () => {
    const r = memReminders();
    expect(() => executeReminderTool(r, 'whatever', {})).toThrow(/unknown/i);
  });
});

describe('reminderTools — timezone handling', () => {
  const originalTz = process.env.TZ;
  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  // Helper: re-initialize Date's TZ cache by constructing a date after env mutation.
  // Note: Node honours TZ at Date construction time, so this is enough for our checks
  // that exercise toISOString / Date.UTC / getTime — all TZ-independent operations.
  function setTz(tz: string): void {
    process.env.TZ = tz;
  }

  it('stores fire_at as a UTC instant — same epoch ms regardless of system TZ', () => {
    // 2030-06-15T09:00:00 in Moscow (UTC+3) === 06:00:00Z
    const moscow9amUtcMs = Date.UTC(2030, 5, 15, 6, 0, 0);

    setTz('Europe/Moscow');
    const r1 = memReminders();
    const out1 = executeReminderTool(r1, 'add_reminder', {
      text: 'meeting',
      fire_at: moscow9amUtcMs,
    });

    setTz('America/Los_Angeles');
    const r2 = memReminders();
    const out2 = executeReminderTool(r2, 'add_reminder', {
      text: 'meeting',
      fire_at: moscow9amUtcMs,
    });

    expect(out1.fire_at).toBe(moscow9amUtcMs);
    expect(out2.fire_at).toBe(moscow9amUtcMs);
    expect(out1.fire_at).toBe(out2.fire_at);
    // fire_at_local differs by TZ — that's intentional (helps the LLM display local time)
    expect(out1.fire_at_local).not.toBe(out2.fire_at_local);
  });

  it('fire_at_local reflects the server timezone (not always UTC)', () => {
    const fireAt = Date.UTC(2030, 0, 1, 12, 30, 0); // 12:30 UTC

    setTz('Europe/Moscow'); // UTC+3 in winter
    const r = memReminders();
    const out = executeReminderTool(r, 'add_reminder', {
      text: 'x',
      fire_at: fireAt,
    });
    // Should reflect Moscow local time (15:30), not UTC (12:30)
    expect(out.fire_at_local).toContain('15:30');
    expect(out.fire_at_local).not.toContain('12:30');
  });

  it('"9 утра в Москве" and the equivalent "11 утра в Токио" land on the same instant', () => {
    // 2030-06-15 09:00 Europe/Moscow (UTC+3)  = 06:00Z
    // 2030-06-15 15:00 Asia/Tokyo (UTC+9)     = 06:00Z
    // 2030-06-14 23:00 America/Los_Angeles (UTC-7 in summer) = 2030-06-15 06:00Z
    const moscow = Date.UTC(2030, 5, 15, 6, 0, 0);
    const tokyo = Date.UTC(2030, 5, 15, 6, 0, 0);
    const la = Date.UTC(2030, 5, 15, 6, 0, 0);

    const r = memReminders();
    const a = executeReminderTool(r, 'add_reminder', { text: 'a', fire_at: moscow });
    const b = executeReminderTool(r, 'add_reminder', { text: 'b', fire_at: tokyo });
    const c = executeReminderTool(r, 'add_reminder', { text: 'c', fire_at: la });
    expect(a.fire_at).toBe(b.fire_at);
    expect(b.fire_at).toBe(c.fire_at);
  });

  it('list_reminders preserves the exact UTC instant; fire_at epoch ms is TZ-independent', () => {
    const fireAt = Date.UTC(2030, 8, 30, 21, 15, 7); // 2030-09-30T21:15:07Z

    setTz('Pacific/Kiritimati'); // UTC+14 — extreme positive offset
    const r = memReminders();
    executeReminderTool(r, 'add_reminder', { text: 'a', fire_at: fireAt });

    setTz('Pacific/Pago_Pago'); // UTC-11 — extreme negative offset
    const list = executeReminderTool(r, 'list_reminders', {});
    expect(list).toHaveLength(1);
    // The epoch ms must survive a round-trip regardless of the listing TZ.
    expect(list[0].fire_at).toBe(fireAt);
    // fire_at_local reflects the listing timezone (Pacific/Pago_Pago = UTC-11):
    // 2030-09-30T21:15:07Z → 2030-09-30T10:15:07-11:00
    expect(list[0].fire_at_local).toContain('10:15');
  });

  it('past-check uses the UTC instant — TZ does not turn a past UTC time into a "future" one', () => {
    // An instant 1h before "now" must be rejected even under a TZ where local
    // wall-clock would naïvely look later than now.
    setTz('Pacific/Kiritimati');
    const r = memReminders();
    const past = Date.now() - 3600_000;
    expect(() => executeReminderTool(r, 'add_reminder', { text: 'x', fire_at: past })).toThrow(
      /past/i,
    );
  });

  it('a future UTC instant is accepted under any TZ', () => {
    const future = Date.now() + 3600_000;
    for (const tz of ['UTC', 'Europe/Moscow', 'America/Los_Angeles', 'Pacific/Pago_Pago']) {
      setTz(tz);
      const r = memReminders();
      expect(() =>
        executeReminderTool(r, 'add_reminder', { text: 'x', fire_at: future }),
      ).not.toThrow();
    }
  });

  it('survives a DST transition: a fixed UTC instant keeps the same epoch ms', () => {
    // US DST "spring forward" 2030-03-10 02:00 local → 03:00 local in America/New_York.
    // The instant 2030-03-10T07:30:00Z is unambiguous in UTC and must round-trip.
    // 07:30 UTC is past the DST boundary (07:00 UTC = 02:00 EST → 03:00 EDT),
    // so local time is 03:30 EDT (UTC-4).
    const fireAt = Date.UTC(2030, 2, 10, 7, 30, 0);

    setTz('America/New_York');
    const r = memReminders();
    const out = executeReminderTool(r, 'add_reminder', {
      text: 'dst',
      fire_at: fireAt,
    });

    expect(out.fire_at).toBe(fireAt);
    // Local representation should reflect America/New_York post-DST (EDT = UTC-4): 03:30
    expect(out.fire_at_local).toContain('03:30');
    // Sanity: epoch ms round-trips correctly via Date.
    expect(new Date(out.fire_at).getTime()).toBe(fireAt);
  });
});
