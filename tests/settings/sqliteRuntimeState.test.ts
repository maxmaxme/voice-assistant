import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { freshTestDb, type TestDb } from '../memory/helpers.ts';
import { SqliteRuntimeState, CONFIG_LOADED_AT } from '../../src/settings/sqliteRuntimeState.ts';

describe('SqliteRuntimeState', () => {
  let h: TestDb;
  let store: SqliteRuntimeState;
  beforeEach(() => {
    h = freshTestDb();
    store = new SqliteRuntimeState(h.db);
  });
  afterEach(() => h.sqlite.close());

  it('returns undefined for an unset key', () => {
    expect(store.get(CONFIG_LOADED_AT)).toBeUndefined();
  });

  it('round-trips a value', () => {
    store.set(CONFIG_LOADED_AT, '1730000000000');
    expect(store.get(CONFIG_LOADED_AT)).toBe('1730000000000');
  });

  it('overwrites an existing key', () => {
    store.set(CONFIG_LOADED_AT, '1');
    store.set(CONFIG_LOADED_AT, '2');
    expect(store.get(CONFIG_LOADED_AT)).toBe('2');
  });
});
