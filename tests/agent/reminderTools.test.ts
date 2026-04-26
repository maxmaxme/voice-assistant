import { describe, it, expect } from 'vitest';
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
      required: expect.arrayContaining(['text', 'fire_at']),
    });
  });

  it('add_reminder writes to the adapter and returns the id', () => {
    const r = memReminders();
    const out = executeReminderTool(r, 'add_reminder', {
      text: 'X',
      fire_at: Date.now() + 60_000,
    }) as { id: number };
    expect(out.id).toBe(1);
    expect(r.listPending()).toHaveLength(1);
  });

  it('add_reminder rejects fire_at in the past with a clear error', () => {
    const r = memReminders();
    expect(() =>
      executeReminderTool(r, 'add_reminder', { text: 'X', fire_at: Date.now() - 60_000 }),
    ).toThrow(/past/i);
  });

  it('list_reminders returns pending only', () => {
    const r = memReminders();
    r.add({ text: 'a', fireAt: Date.now() + 100_000 });
    const fired = r.add({ text: 'b', fireAt: 50 });
    r.markFired(fired.id, 50);
    const out = executeReminderTool(r, 'list_reminders', {}) as Array<{ text: string }>;
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
