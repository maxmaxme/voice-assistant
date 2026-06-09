import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { freshTestDb, type TestDb } from './helpers.ts';
import { SqliteTelegramSessions } from '../../src/memory/sqliteTelegramSessions.ts';

describe('SqliteTelegramSessions', () => {
  let h: TestDb;
  let s: SqliteTelegramSessions;

  beforeEach(() => {
    h = freshTestDb();
    s = new SqliteTelegramSessions(h.db);
  });
  afterEach(() => h.sqlite.close());

  it('returns null for an unknown chat', () => {
    expect(s.get(1)).toBeNull();
  });

  it('round-trips a record with pending tool outputs', () => {
    s.save(42, {
      lastResponseId: 'resp_1',
      pendingAskCallId: 'call_1',
      pendingToolOutputs: [{ callId: 'c1', output: 'ok' }],
    });
    expect(s.get(42)).toEqual({
      lastResponseId: 'resp_1',
      pendingAskCallId: 'call_1',
      pendingToolOutputs: [{ callId: 'c1', output: 'ok' }],
    });
  });

  it('round-trips pendingAskExpiresAt', () => {
    s.save(42, {
      lastResponseId: 'resp_1',
      pendingAskCallId: 'call_1',
      pendingAskExpiresAt: 1_234_567,
    });
    const rec = s.get(42);
    expect(rec?.pendingAskCallId).toBe('call_1');
    expect(rec?.pendingAskExpiresAt).toBe(1_234_567);
  });

  it('drops empty pending outputs to undefined', () => {
    s.save(42, { lastResponseId: 'resp_1', pendingToolOutputs: [] });
    const rec = s.get(42);
    expect(rec?.lastResponseId).toBe('resp_1');
    expect(rec?.pendingToolOutputs).toBeUndefined();
  });

  it('upserts on conflict — a second save over the same chat updates the row', () => {
    s.save(42, {
      lastResponseId: 'resp_1',
      pendingAskCallId: 'call_1',
      pendingToolOutputs: [{ callId: 'c1', output: 'ok' }],
    });
    // Second save hits the DO UPDATE branch: fields are overwritten, and the
    // omitted/empty pending outputs are cleared back to undefined.
    s.save(42, { lastResponseId: 'resp_2' });
    expect(s.get(42)).toEqual({
      lastResponseId: 'resp_2',
      pendingAskCallId: undefined,
      pendingToolOutputs: undefined,
    });
  });

  it('delete removes the record', () => {
    s.save(7, { lastResponseId: 'x' });
    s.delete(7);
    expect(s.get(7)).toBeNull();
  });
});
