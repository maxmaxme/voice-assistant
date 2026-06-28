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

  it('seedWithDefault sets content and default on a fresh prompt', () => {
    store.seedWithDefault('base-system', 'bundled text');
    const row = store.list().find((p) => p.name === 'base-system');
    expect(row?.content).toBe('bundled text');
    expect(row?.defaultContent).toBe('bundled text');
  });

  it('seedWithDefault refreshes default but never clobbers an edited content', () => {
    store.seedWithDefault('base-system', 'v1 default');
    store.set('base-system', 'user edit');
    store.seedWithDefault('base-system', 'v2 default'); // e.g. new image ships a newer default
    const row = store.list().find((p) => p.name === 'base-system');
    expect(row?.content).toBe('user edit');
    expect(row?.defaultContent).toBe('v2 default');
  });

  it('resetToDefault restores content from the stored default', () => {
    store.seedWithDefault('base-system', 'the default');
    store.set('base-system', 'edited');
    expect(store.resetToDefault('base-system')).toBe(true);
    expect(store.get('base-system')).toBe('the default');
  });

  it('resetToDefault returns false for an unknown prompt', () => {
    expect(store.resetToDefault('nope')).toBe(false);
  });
});
