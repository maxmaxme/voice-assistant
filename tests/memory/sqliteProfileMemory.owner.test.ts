import { describe, it, expect } from 'vitest';
import { freshTestDb } from './helpers.ts';
import { SqliteProfileMemory } from '../../src/memory/sqliteProfileMemory.ts';

function freshStore(): SqliteProfileMemory {
  return new SqliteProfileMemory(freshTestDb().db);
}

describe('SqliteProfileMemory owner-aware primitives', () => {
  it('writes/reads per owner', () => {
    const m = freshStore();
    m.rememberFor('household', 'tv', 'Samsung');
    m.rememberFor('user:1', 'snack', 'olives');
    expect(m.recallFor(['household'])).toEqual({ tv: 'Samsung' });
    expect(m.recallFor(['user:1'])).toEqual({ snack: 'olives' });
  });

  it('merges read owners, later owner overrides on key collision', () => {
    const m = freshStore();
    m.rememberFor('household', 'temp', 21);
    m.rememberFor('user:1', 'temp', 23);
    expect(m.recallFor(['household', 'user:1'])).toEqual({ temp: 23 });
  });

  it('recallFor with a key reads that key across the owner-set', () => {
    const m = freshStore();
    m.rememberFor('household', 'temp', 21);
    expect(m.recallFor(['household', 'user:1'], 'temp')).toEqual({ temp: 21 });
  });

  it('forgetFor deletes only from the given owner', () => {
    const m = freshStore();
    m.rememberFor('household', 'x', 1);
    m.rememberFor('user:1', 'x', 2);
    m.forgetFor('user:1', 'x');
    expect(m.recallFor(['household', 'user:1'])).toEqual({ x: 1 });
  });

  it('back-compat remember/recall/forget operate on household', () => {
    const m = freshStore();
    m.remember('name', 'Max');
    expect(m.recall()).toEqual({ name: 'Max' });
    expect(m.recallFor(['household'])).toEqual({ name: 'Max' });
    m.forget('name');
    expect(m.recall()).toEqual({});
  });
});
