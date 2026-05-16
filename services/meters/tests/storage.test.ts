import { describe, it, expect, beforeEach } from 'vitest';
import { openSubmissionsStore } from '../src/storage/sqlite.ts';
import type { SubmissionsStore, MeterReading } from '../src/storage/types.ts';

const READINGS: MeterReading[] = [
  { meter: 'M1', kind: 'ГВС м3', value: 15.013 },
  { meter: 'M2', kind: 'Отопление', value: 10.54 },
];

const INFO = { accountId: 'ACC', balanceText: 'переплата 1 руб' };

let store: SubmissionsStore;

beforeEach(() => {
  store = openSubmissionsStore(':memory:');
});

describe('SubmissionsStore', () => {
  it('getOrCreate returns a fresh pending row, then the same row on second call', () => {
    const a = store.getOrCreate('tgc1', '2026-05');
    expect(a).toMatchObject({
      portal: 'tgc1',
      period: '2026-05',
      status: 'pending',
      attempts: 0,
      submittedValues: null,
      accountInfo: null,
      notifiedWindowClosed: false,
    });

    const b = store.getOrCreate('tgc1', '2026-05');
    expect(b.attempts).toBe(0);
  });

  it('markDone records values, info, status, submittedAt', () => {
    store.getOrCreate('tgc1', '2026-05');
    store.markDone('tgc1', '2026-05', READINGS, INFO);

    const row = store.getOrCreate('tgc1', '2026-05');
    expect(row.status).toBe('done');
    expect(row.submittedValues).toEqual(READINGS);
    expect(row.accountInfo).toEqual(INFO);
    expect(row.submittedAt).not.toBeNull();
  });

  it('markFailed increments attempts and records error', () => {
    store.getOrCreate('tgc1', '2026-05');
    store.markFailed('tgc1', '2026-05', 'TimeoutError');
    store.markFailed('tgc1', '2026-05', 'TimeoutError again');

    const row = store.getOrCreate('tgc1', '2026-05');
    expect(row.attempts).toBe(2);
    expect(row.lastError).toBe('TimeoutError again');
    expect(row.status).toBe('failed');
  });

  it('markBlocked sets status to blocked', () => {
    store.getOrCreate('tgc1', '2026-05');
    store.markBlocked('tgc1', '2026-05');
    expect(store.getOrCreate('tgc1', '2026-05').status).toBe('blocked');
  });

  it('markWindowClosedNotified flips the one-shot flag', () => {
    store.getOrCreate('tgc1', '2026-05');
    expect(store.getOrCreate('tgc1', '2026-05').notifiedWindowClosed).toBe(false);
    store.markWindowClosedNotified('tgc1', '2026-05');
    expect(store.getOrCreate('tgc1', '2026-05').notifiedWindowClosed).toBe(true);
  });

  it('lastSubmittedValueFor returns the most recent done value for a meter', () => {
    store.getOrCreate('tgc1', '2026-04');
    store.markDone('tgc1', '2026-04', READINGS, INFO);

    expect(store.lastSubmittedValueFor('tgc1', 'M1')).toBe(15.013);
    expect(store.lastSubmittedValueFor('tgc1', 'M2')).toBe(10.54);
    expect(store.lastSubmittedValueFor('tgc1', 'M3')).toBeNull();
    expect(store.lastSubmittedValueFor('pesc', 'M1')).toBeNull();
  });

  it('lastSubmittedValueFor ignores rows that are not done', () => {
    store.getOrCreate('tgc1', '2026-05');
    store.markFailed('tgc1', '2026-05', 'err');
    expect(store.lastSubmittedValueFor('tgc1', 'M1')).toBeNull();
  });
});
