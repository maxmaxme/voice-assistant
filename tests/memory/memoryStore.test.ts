import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

  it('exposes profile and scheduledActions on one DB', () => {
    const m = openMemoryStore(dbPath);
    m.profile.remember('name', 'Maxim');
    const created = m.scheduledActions.add({
      goal: 'water plants',
      schedule: { kind: 'once', at: 1000 },
      nextFireAt: 1000,
      ownerUserId: 1,
    });
    expect(m.profile.recall('name')).toEqual({ name: 'Maxim' });
    expect(m.scheduledActions.listActiveForOwner(1)[0].id).toBe(created.id);
    m.close();
  });

  it('survives reopen — data persisted', () => {
    {
      const m = openMemoryStore(dbPath);
      m.profile.remember('x', 1);
      m.scheduledActions.add({
        goal: 'persist me',
        schedule: { kind: 'once', at: 5 },
        nextFireAt: 5,
        ownerUserId: 1,
      });
      m.close();
    }
    const m2 = openMemoryStore(dbPath);
    expect(m2.profile.recall('x')).toEqual({ x: 1 });
    expect(m2.scheduledActions.listActiveForOwner(1)[0].goal).toBe('persist me');
    m2.close();
  });
});

const TMP = `/tmp/va-memstore-task8-${process.pid}.db`;
afterEach(() => {
  for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) {
    if (fs.existsSync(f)) {
      fs.rmSync(f);
    }
  }
});

describe('openMemoryStore identities + profileStore', () => {
  it('exposes identities and the raw profile store', () => {
    const store = openMemoryStore(TMP);
    expect(store.identities.isEmpty()).toBe(true);
    store.profileStore.rememberFor('household', 'x', 1);
    expect(store.profileStore.recallFor(['household'])).toEqual({ x: 1 });
    store.close();
  });
});
