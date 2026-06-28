import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { freshTestDb, type TestDb } from '../memory/helpers.ts';
import { SqliteSettings } from '../../src/settings/sqliteSettings.ts';
import { buildEnvOverlay, SETTABLE_KEYS } from '../../src/settings/settable.ts';

describe('buildEnvOverlay', () => {
  let h: TestDb;
  let store: SqliteSettings;
  beforeEach(() => {
    h = freshTestDb();
    store = new SqliteSettings(h.db);
  });
  afterEach(() => h.sqlite.close());

  it('returns only whitelisted (settable) keys', () => {
    store.set('AGENT_MODE', 'both');
    store.set('OPENAI_API_KEY', 'sk-should-be-ignored');
    expect(buildEnvOverlay(store)).toEqual({ AGENT_MODE: 'both' });
  });

  it('is empty when nothing settable is stored', () => {
    store.set('HA_TOKEN', 'secret');
    expect(buildEnvOverlay(store)).toEqual({});
  });

  it('SETTABLE_KEYS never exposes a secret', () => {
    const names = SETTABLE_KEYS.map((k) => k.key);
    expect(names).not.toContain('OPENAI_API_KEY');
    expect(names).not.toContain('HA_TOKEN');
    expect(names).not.toContain('TELEGRAM_BOT_TOKEN');
    expect(names).not.toContain('VA_DEVICE_TOKEN');
  });
});
