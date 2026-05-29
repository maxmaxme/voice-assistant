import { describe, it, expect } from 'vitest';
import { buildLocalToolset } from '../../src/agent/localTools.ts';
import type { ScopedProfile } from '../../src/memory/scope.ts';

function fakeScoped(): ScopedProfile {
  const store = new Map<string, unknown>();
  return {
    recall: (key) => (key ? { [key]: store.get(key) } : Object.fromEntries(store)),
    remember: (key, value) => void store.set(key, value),
    forget: (key) => void store.delete(key),
  };
}

describe('buildLocalToolset with scoped profile', () => {
  it('exposes memory tools when a profile is given and routes them', async () => {
    const ts = buildLocalToolset({ profile: fakeScoped() });
    expect(ts.names.has('remember')).toBe(true);
    expect(await ts.execute('remember', { key: 'a', value: 1 })).toEqual({ ok: true });
    expect(await ts.execute('recall', { key: 'a' })).toEqual({ a: 1 });
  });

  it('omits memory tools when no profile is given', () => {
    const ts = buildLocalToolset({});
    expect(ts.names.has('remember')).toBe(false);
  });
});
