import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteProfileMemory } from '../../src/memory/sqliteProfileMemory.js';

describe('SqliteProfileMemory', () => {
  let m: SqliteProfileMemory;

  beforeEach(() => {
    m = new SqliteProfileMemory({ dbPath: ':memory:' });
  });
  afterEach(() => m.close());

  it('starts empty', () => {
    expect(m.recall()).toEqual({});
  });

  it('remember + recall by key', () => {
    m.remember('name', 'Maxim');
    expect(m.recall('name')).toEqual({ name: 'Maxim' });
  });

  it('remember overwrites existing key', () => {
    m.remember('temp', 22);
    m.remember('temp', 21);
    expect(m.recall('temp')).toEqual({ temp: 21 });
  });

  it('recall() with no key returns full profile', () => {
    m.remember('name', 'Maxim');
    m.remember('coffee', { sugar: false });
    expect(m.recall()).toEqual({ name: 'Maxim', coffee: { sugar: false } });
  });

  it('forget removes a key', () => {
    m.remember('name', 'Maxim');
    m.forget('name');
    expect(m.recall()).toEqual({});
  });

  it('forget on missing key is a no-op', () => {
    expect(() => m.forget('nope')).not.toThrow();
  });

  it('handles non-string values via JSON', () => {
    m.remember('list', [1, 2, 3]);
    m.remember('flag', true);
    expect(m.recall()).toEqual({ list: [1, 2, 3], flag: true });
  });
});
