import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { freshTestDb, type TestDb } from '../memory/helpers.ts';
import { SqliteSettings } from '../../src/settings/sqliteSettings.ts';
import { resolveRealtimeConfig, REALTIME_KEYS } from '../../src/settings/realtimeConfig.ts';

describe('resolveRealtimeConfig', () => {
  let h: TestDb;
  let store: SqliteSettings;
  beforeEach(() => {
    h = freshTestDb();
    store = new SqliteSettings(h.db);
  });
  afterEach(() => h.sqlite.close());

  it('defaults to disabled with built-in pacing/idle when nothing is stored', () => {
    expect(resolveRealtimeConfig(store)).toEqual({
      enabled: false,
      outputPacingMs: 20,
      idleResetMs: 90_000,
    });
  });

  it('reads stored values', () => {
    store.set(REALTIME_KEYS.enabled, '1');
    store.set(REALTIME_KEYS.outputPacingMs, '40');
    store.set(REALTIME_KEYS.idleResetMs, '5000');
    expect(resolveRealtimeConfig(store)).toEqual({
      enabled: true,
      outputPacingMs: 40,
      idleResetMs: 5000,
    });
  });

  it('falls back to defaults for blank or non-numeric values', () => {
    store.set(REALTIME_KEYS.outputPacingMs, '');
    store.set(REALTIME_KEYS.idleResetMs, 'bogus');
    const cfg = resolveRealtimeConfig(store);
    expect(cfg.outputPacingMs).toBe(20);
    expect(cfg.idleResetMs).toBe(90_000);
  });

  it('treats any non-"1" enabled value as disabled', () => {
    store.set(REALTIME_KEYS.enabled, 'true');
    expect(resolveRealtimeConfig(store).enabled).toBe(false);
  });
});
