import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/memory/migrate.ts';
import { SqliteProfileMemory } from '../../src/memory/sqliteProfileMemory.ts';
import {
  makeScopedProfile,
  householdProfile,
  householdFromAdapter,
  HOUSEHOLD_OWNER,
  personalOwner,
} from '../../src/memory/scope.ts';

function store(): SqliteProfileMemory {
  const db = new Database(':memory:');
  runMigrations(db);
  return new SqliteProfileMemory({ db });
}

describe('scope', () => {
  it('personalOwner formats owner string', () => {
    expect(personalOwner(7)).toBe('user:7');
    expect(HOUSEHOLD_OWNER).toBe('household');
  });

  it('member scope reads household ∪ personal, writes personal by default', () => {
    const m = store();
    m.rememberFor(HOUSEHOLD_OWNER, 'tv', 'Samsung');
    const p = makeScopedProfile(m, { role: 'member', userId: 7 });
    p.remember('snack', 'olives');
    expect(p.recall()).toEqual({ tv: 'Samsung', snack: 'olives' });
    expect(m.recallFor([personalOwner(7)])).toEqual({ snack: 'olives' });
    expect(m.recallFor([HOUSEHOLD_OWNER])).toEqual({ tv: 'Samsung' });
  });

  it('member scope writes household when scope=household', () => {
    const m = store();
    const p = makeScopedProfile(m, { role: 'member', userId: 7 });
    p.remember('quiet_hours', '22-7', 'household');
    expect(m.recallFor([HOUSEHOLD_OWNER])).toEqual({ quiet_hours: '22-7' });
    expect(m.recallFor([personalOwner(7)])).toEqual({});
  });

  it('shared scope reads/writes household only; scope arg is ignored', () => {
    const m = store();
    const p = makeScopedProfile(m, { role: 'shared', userId: 1 });
    p.remember('tv', 'Samsung', 'personal');
    expect(m.recallFor([HOUSEHOLD_OWNER])).toEqual({ tv: 'Samsung' });
    expect(m.recallFor([personalOwner(1)])).toEqual({});
  });

  it('householdProfile is a shared-scope convenience', () => {
    const m = store();
    const p = householdProfile(m);
    p.remember('x', 1);
    expect(m.recallFor([HOUSEHOLD_OWNER])).toEqual({ x: 1 });
  });

  it('householdFromAdapter delegates to the adapter (scope arg ignored)', () => {
    const calls: Array<[string, string, unknown]> = [];
    const adapter = {
      recall: (key?: string) => (key ? { [key]: 'v' } : { a: 1 }),
      remember: (key: string, value: unknown) => void calls.push(['remember', key, value]),
      forget: (key: string) => void calls.push(['forget', key, undefined]),
    };
    const p = householdFromAdapter(adapter);
    p.remember('k', 2, 'household'); // scope arg accepted but ignored by the wrapper
    p.forget('k');
    expect(calls).toEqual([
      ['remember', 'k', 2],
      ['forget', 'k', undefined],
    ]);
    expect(p.recall()).toEqual({ a: 1 });
    expect(p.recall('x')).toEqual({ x: 'v' });
  });
});
