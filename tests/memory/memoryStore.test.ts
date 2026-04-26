import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openMemoryStore } from '../../src/memory/memoryStore.ts';

describe('openMemoryStore', () => {
  let dbPath: string;
  beforeEach(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memstore-'));
    dbPath = path.join(dir, 'a.db');
  });

  it('exposes profile, reminders, timers on one DB', () => {
    const m = openMemoryStore(dbPath);
    m.profile.remember('name', 'Maxim');
    m.reminders.add({ text: 'r', fireAt: 1 });
    m.timers.add({ label: 't', fireAt: 1, durationMs: 1 });
    expect(m.profile.recall('name')).toEqual({ name: 'Maxim' });
    expect(m.reminders.listPending()[0].text).toBe('r');
    expect(m.timers.listActive()[0].label).toBe('t');
    m.close();
  });

  it('survives reopen — data persisted', () => {
    {
      const m = openMemoryStore(dbPath);
      m.profile.remember('x', 1);
      m.reminders.add({ text: 'persist', fireAt: 5 });
      m.close();
    }
    const m2 = openMemoryStore(dbPath);
    expect(m2.profile.recall('x')).toEqual({ x: 1 });
    expect(m2.reminders.listPending()[0].text).toBe('persist');
    m2.close();
  });
});
