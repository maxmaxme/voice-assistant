import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { freshTestDb, type TestDb } from '../memory/helpers.ts';
import { SqliteSettings } from '../../src/settings/sqliteSettings.ts';

describe('SqliteSettings', () => {
  let h: TestDb;
  let store: SqliteSettings;
  beforeEach(() => {
    h = freshTestDb();
    store = new SqliteSettings(h.db);
  });
  afterEach(() => h.sqlite.close());

  it('returns undefined for an unset key', () => {
    expect(store.get('OPENAI_MODEL')).toBeUndefined();
  });

  it('round-trips a value', () => {
    store.set('OPENAI_MODEL', 'gpt-5');
    expect(store.get('OPENAI_MODEL')).toBe('gpt-5');
  });

  it('overwrites an existing key', () => {
    store.set('OPENAI_MODEL', 'gpt-5');
    store.set('OPENAI_MODEL', 'gpt-6');
    expect(store.get('OPENAI_MODEL')).toBe('gpt-6');
  });

  it('getAll returns every stored key/value', () => {
    store.set('OPENAI_MODEL', 'gpt-5');
    store.set('AGENT_MODE', 'http');
    expect(store.getAll()).toEqual({ OPENAI_MODEL: 'gpt-5', AGENT_MODE: 'http' });
  });

  it('getAll is empty on a fresh store', () => {
    expect(store.getAll()).toEqual({});
  });

  it('delete removes a key', () => {
    store.set('OPENAI_MODEL', 'gpt-5');
    store.delete('OPENAI_MODEL');
    expect(store.get('OPENAI_MODEL')).toBeUndefined();
  });
});
