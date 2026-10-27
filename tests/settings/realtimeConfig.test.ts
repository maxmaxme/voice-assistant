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

  it('uses built-in defaults when nothing is stored', () => {
    expect(resolveRealtimeConfig(store)).toEqual({
      idleResetMs: 90_000,
      requestFollowUpMs: 10_000,
      followUpChime: false,
      wakeChime: true,
      language: '',
      transcription: false,
      transcriptionModel: 'whisper-1',
      noiseReduction: 'far_field',
      turnDetection: 'server_vad',
    });
  });

  it('reads stored values', () => {
    store.set(REALTIME_KEYS.idleResetMs, '5000');
    store.set(REALTIME_KEYS.requestFollowUpMs, '15000');
    store.set(REALTIME_KEYS.followUpChime, '0');
    store.set(REALTIME_KEYS.wakeChime, '0');
    store.set(REALTIME_KEYS.language, ' RU ');
    store.set(REALTIME_KEYS.transcription, '1');
    store.set(REALTIME_KEYS.transcriptionModel, 'gpt-4o-mini-transcribe');
    store.set(REALTIME_KEYS.noiseReduction, 'off');
    store.set(REALTIME_KEYS.turnDetection, 'semantic_low');
    expect(resolveRealtimeConfig(store)).toEqual({
      idleResetMs: 5000,
      requestFollowUpMs: 15000,
      followUpChime: false,
      wakeChime: false,
      language: 'ru',
      transcription: true,
      transcriptionModel: 'gpt-4o-mini-transcribe',
      noiseReduction: 'off',
      turnDetection: 'semantic_low',
    });
  });

  it('falls back to defaults for blank or non-numeric values', () => {
    store.set(REALTIME_KEYS.idleResetMs, '');
    store.set(REALTIME_KEYS.requestFollowUpMs, 'bogus');
    store.set(REALTIME_KEYS.noiseReduction, 'bogus');
    store.set(REALTIME_KEYS.turnDetection, 'semantic_vad');
    store.set(REALTIME_KEYS.transcriptionModel, 'gpt-5-transcribe');
    const cfg = resolveRealtimeConfig(store);
    expect(cfg.noiseReduction).toBe('far_field');
    expect(cfg.turnDetection).toBe('server_vad');
    expect(cfg.transcriptionModel).toBe('whisper-1');
    expect(cfg.idleResetMs).toBe(90_000);
    expect(cfg.requestFollowUpMs).toBe(10_000);
  });

  it('falls back to defaults for negative values', () => {
    store.set(REALTIME_KEYS.idleResetMs, '-1');
    store.set(REALTIME_KEYS.requestFollowUpMs, '-15000');
    const cfg = resolveRealtimeConfig(store);
    expect(cfg.idleResetMs).toBe(90_000);
    expect(cfg.requestFollowUpMs).toBe(10_000);
  });

  it('accepts follow-up disabled (0)', () => {
    store.set(REALTIME_KEYS.requestFollowUpMs, '0');
    expect(resolveRealtimeConfig(store).requestFollowUpMs).toBe(0);
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
    store.set(REALTIME_KEYS.language, ' RU ');
    store.set(REALTIME_KEYS.transcription, '1');
    store.set(REALTIME_KEYS.noiseReduction, 'off');
    expect(resolveRealtimeConfig(store).wakeChime).toBe(false);
  });
});
