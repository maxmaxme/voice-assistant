import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { freshTestDb, type TestDb } from '../memory/helpers.ts';
import { SqlitePrompts } from '../../src/settings/sqlitePrompts.ts';

describe('SqlitePrompts', () => {
  let h: TestDb;
  let store: SqlitePrompts;
  beforeEach(() => {
    h = freshTestDb();
    store = new SqlitePrompts(h.db);
  });
  afterEach(() => h.sqlite.close());

  it('returns undefined for an unset prompt', () => {
    expect(store.get('base-system')).toBeUndefined();
  });

  it('round-trips a prompt', () => {
    store.set('base-system', 'You are a helper.');
    expect(store.get('base-system')).toBe('You are a helper.');
  });

  it('seedIfAbsent stores the content when missing', () => {
    store.seedIfAbsent('base-system', 'seeded');
    expect(store.get('base-system')).toBe('seeded');
  });

  it('seedIfAbsent does not overwrite an existing prompt', () => {
    store.set('base-system', 'edited by user');
    store.seedIfAbsent('base-system', 'bundled default');
    expect(store.get('base-system')).toBe('edited by user');
  });

  it('list returns all prompts with names and content', () => {
    store.set('base-system', 'a');
    store.set('voice-addendum', 'b');
    const names = store.list().map((p) => p.name);
    expect(names).toEqual(expect.arrayContaining(['base-system', 'voice-addendum']));
  });
});
