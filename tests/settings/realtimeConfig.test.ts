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

  it('defaults to disabled with built-in pacing/idle/follow-up when nothing is stored', () => {
    expect(resolveRealtimeConfig(store)).toEqual({
      enabled: false,
      outputPacingMs: 20,
      idleResetMs: 90_000,
      followUpMs: 8_000,
      requestFollowUpMs: 10_000,
      followUpChime: false,
      wakeChime: true,
    });
  });

  it('reads stored values', () => {
    store.set(REALTIME_KEYS.enabled, '1');
    store.set(REALTIME_KEYS.outputPacingMs, '40');
    store.set(REALTIME_KEYS.idleResetMs, '5000');
    store.set(REALTIME_KEYS.followUpMs, '12000');
    store.set(REALTIME_KEYS.requestFollowUpMs, '15000');
    store.set(REALTIME_KEYS.followUpChime, '0');
    store.set(REALTIME_KEYS.wakeChime, '0');
    expect(resolveRealtimeConfig(store)).toEqual({
      enabled: true,
      outputPacingMs: 40,
      idleResetMs: 5000,
      followUpMs: 12000,
      requestFollowUpMs: 15000,
      followUpChime: false,
      wakeChime: false,
    });
  });

  it('falls back to defaults for blank or non-numeric values', () => {
    store.set(REALTIME_KEYS.outputPacingMs, '');
    store.set(REALTIME_KEYS.idleResetMs, 'bogus');
    store.set(REALTIME_KEYS.followUpMs, 'bogus');
    const cfg = resolveRealtimeConfig(store);
    expect(cfg.outputPacingMs).toBe(20);
    expect(cfg.idleResetMs).toBe(90_000);
    expect(cfg.followUpMs).toBe(8_000);
  });

  it('falls back to defaults for negative values', () => {
    store.set(REALTIME_KEYS.outputPacingMs, '-5');
    store.set(REALTIME_KEYS.idleResetMs, '-1');
    store.set(REALTIME_KEYS.followUpMs, '-100');
    store.set(REALTIME_KEYS.requestFollowUpMs, '-15000');
    const cfg = resolveRealtimeConfig(store);
    expect(cfg.outputPacingMs).toBe(20);
    expect(cfg.idleResetMs).toBe(90_000);
    expect(cfg.followUpMs).toBe(8_000);
    expect(cfg.requestFollowUpMs).toBe(10_000);
  });

  it('accepts follow-up disabled (0)', () => {
    store.set(REALTIME_KEYS.followUpMs, '0');
    expect(resolveRealtimeConfig(store).followUpMs).toBe(0);
  });

  it('follow-up chime is off by default and only "1" turns it on', () => {
    expect(resolveRealtimeConfig(store).followUpChime).toBe(false);
    store.set(REALTIME_KEYS.followUpChime, '0');
    expect(resolveRealtimeConfig(store).followUpChime).toBe(false);
    store.set(REALTIME_KEYS.followUpChime, '1');
    expect(resolveRealtimeConfig(store).followUpChime).toBe(true);
  });

  it('wake chime is on by default and only "0" turns it off', () => {
    expect(resolveRealtimeConfig(store).wakeChime).toBe(true);
    store.set(REALTIME_KEYS.wakeChime, '1');
    expect(resolveRealtimeConfig(store).wakeChime).toBe(true);
    store.set(REALTIME_KEYS.wakeChime, '0');
    expect(resolveRealtimeConfig(store).wakeChime).toBe(false);
  });

  it('treats any non-"1" enabled value as disabled', () => {
    store.set(REALTIME_KEYS.enabled, 'true');
    expect(resolveRealtimeConfig(store).enabled).toBe(false);
  });
});
