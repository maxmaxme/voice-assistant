import { describe, it, expect } from 'vitest';
import { freshTestDb } from './helpers.ts';
import { SqliteProfileMemory } from '../../src/memory/sqliteProfileMemory.ts';
import {
  makeScopedProfile,
  householdProfile,
  householdFromAdapter,
  HOUSEHOLD_OWNER,
  personalOwner,
} from '../../src/memory/scope.ts';

function store(): SqliteProfileMemory {
  return new SqliteProfileMemory(freshTestDb().db);
}

describe('scope', () => {
  it('personalOwner formats owner string', () => {
    expect(personalOwner(7)).toBe('user:7');
    expect(HOUSEHOLD_OWNER).toBe('household');
  });

  it('scope reads household ∪ personal, writes personal by default', () => {
    const m = store();
    m.rememberFor(HOUSEHOLD_OWNER, 'tv', 'Samsung');
    const p = makeScopedProfile(m, { userId: 7 });
    p.remember('snack', 'olives');
    expect(p.recall()).toEqual({ tv: 'Samsung', snack: 'olives' });
    expect(m.recallFor([personalOwner(7)])).toEqual({ snack: 'olives' });
    expect(m.recallFor([HOUSEHOLD_OWNER])).toEqual({ tv: 'Samsung' });
  });

  it('scope writes household when scope=household', () => {
    const m = store();
    const p = makeScopedProfile(m, { userId: 7 });
    p.remember('quiet_hours', '22-7', 'household');
    expect(m.recallFor([HOUSEHOLD_OWNER])).toEqual({ quiet_hours: '22-7' });
    expect(m.recallFor([personalOwner(7)])).toEqual({});
  });

  it("a second principal does not see the first principal's personal; household is shared", () => {
    const m = store();
    m.rememberFor(HOUSEHOLD_OWNER, 'tv', 'Samsung');
    const a = makeScopedProfile(m, { userId: 7 });
    const b = makeScopedProfile(m, { userId: 8 });
    a.remember('snack', 'olives');
    // user 8 sees the shared household fact but not user 7's personal one.
    expect(b.recall()).toEqual({ tv: 'Samsung' });
    // user 7 still sees both.
    expect(a.recall()).toEqual({ tv: 'Samsung', snack: 'olives' });
  });

  describe('forget is personal-first and reports which scope it touched', () => {
    it('deletes the personal copy first, revealing the shadowed household value', () => {
      const m = store();
      m.rememberFor(HOUSEHOLD_OWNER, 'alias', 'Кондиционер');
      const p = makeScopedProfile(m, { userId: 7 });
      p.remember('alias', 'сплит'); // personal override
      expect(p.recall()).toEqual({ alias: 'сплит' });

      const result = p.forget('alias');

      expect(result).toEqual({ deleted: true, scope: 'personal', revealed: true });
      // the household value now surfaces again instead of being gone
      expect(p.recall()).toEqual({ alias: 'Кондиционер' });
    });

    it('reports a personal-only key without revealing anything', () => {
      const m = store();
      const p = makeScopedProfile(m, { userId: 7 });
      p.remember('snack', 'olives');

      const result = p.forget('snack');

      expect(result).toEqual({ deleted: true, scope: 'personal', revealed: false });
      expect(p.recall()).toEqual({});
    });

    it('falls through to household when there is no personal copy', () => {
      const m = store();
      m.rememberFor(HOUSEHOLD_OWNER, 'tv', 'Samsung');
      const p = makeScopedProfile(m, { userId: 7 });

      const result = p.forget('tv');

      expect(result).toEqual({ deleted: true, scope: 'household' });
      expect(p.recall()).toEqual({});
    });

    it('reports nothing deleted for an unknown key', () => {
      const m = store();
      const p = makeScopedProfile(m, { userId: 7 });

      expect(p.forget('nope')).toEqual({ deleted: false });
    });

    it("never deletes another principal's personal entry", () => {
      const m = store();
      const a = makeScopedProfile(m, { userId: 7 });
      const b = makeScopedProfile(m, { userId: 8 });
      a.remember('alias', 'сплит');

      // user 8 asks to forget the same key — they have no such entry.
      expect(b.forget('alias')).toEqual({ deleted: false });
      // user 7's personal entry is untouched.
      expect(a.recall()).toEqual({ alias: 'сплит' });
    });
  });

  it('householdProfile is a household-only convenience', () => {
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
