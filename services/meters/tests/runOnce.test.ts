import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runOnce } from '../src/runOnce.ts';
import type { Portal, PortalDeps } from '../src/portals/types.ts';
import type { Page } from 'playwright';
import type { SubmissionsStore, MeterReading } from '../src/storage/types.ts';
import type { Notifier } from '../src/notify/types.ts';
import { openSubmissionsStore } from '../src/storage/sqlite.ts';

const READINGS: MeterReading[] = [
  { meter: 'M1', kind: 'ГВС', value: 1 },
  { meter: 'M2', kind: 'Отопление', value: 2 },
];

function makePortal(impl: Partial<Portal> = {}): Portal {
  const base: Portal = {
    name: 'tgc1',
    fetchAccountInfo: vi.fn(async () => ({ accountId: 'ACC', balanceText: 'переплата 1 руб' })),
    submit: vi.fn(async () => READINGS),
  };
  return { ...base, ...impl };
}

function makeNotifier(): Notifier & { calls: Record<string, unknown[]> } {
  const calls = {
    success: [] as unknown[],
    failure: [] as unknown[],
    windowClosed: [] as unknown[],
  };
  return {
    calls,
    success: vi.fn(async (i) => void calls.success.push(i)),
    failure: vi.fn(async (i) => void calls.failure.push(i)),
    windowClosed: vi.fn(async (i) => void calls.windowClosed.push(i)),
  };
}

function makePage(): Page {
  // The portal mocks never touch the page; an empty object suffices for the stub.
  const stub: Record<string, unknown> = {};
  return stub as unknown as Page;
}

const withPageStub = async <T>(
  _: unknown,
  fn: (sess: {
    page: Page;
    screenshotOnFailure: (l: string) => Promise<string | null>;
  }) => Promise<T>,
): Promise<T> => fn({ page: makePage(), screenshotOnFailure: async () => '/data/s.png' });

const portalDepsFor: (name: string) => PortalDeps = () => ({
  login: 'l',
  password: 'p',
  lastSubmittedValueFor: () => null,
  today: () => new Date(),
});

let store: SubmissionsStore;

beforeEach(() => {
  store = openSubmissionsStore(':memory:');
});

describe('runOnce', () => {
  it('skips entirely if today is before targetDay and not forced', async () => {
    const portal = makePortal();
    const notifier = makeNotifier();

    await runOnce({
      store,
      notifier,
      portals: [portal],
      withPage: withPageStub,
      portalDepsFor,
      now: new Date('2026-05-10T09:00:00Z'),
      force: false,
    });

    expect(portal.submit).not.toHaveBeenCalled();
    expect(notifier.calls.success).toHaveLength(0);
  });

  it('runs on targetDay, marks done, notifies success', async () => {
    const portal = makePortal();
    const notifier = makeNotifier();

    // 2026-05-15 is Friday → targetDay = 15
    await runOnce({
      store,
      notifier,
      portals: [portal],
      withPage: withPageStub,
      portalDepsFor,
      now: new Date('2026-05-15T09:00:00Z'),
      force: false,
    });

    expect(portal.submit).toHaveBeenCalledOnce();
    expect(notifier.calls.success).toHaveLength(1);
    expect(store.getOrCreate('tgc1', '2026-05').status).toBe('done');
  });

  it('skips a portal that is already done', async () => {
    const portal = makePortal();
    const notifier = makeNotifier();

    store.getOrCreate('tgc1', '2026-05');
    store.markDone('tgc1', '2026-05', READINGS, { accountId: 'ACC', balanceText: 'x' });

    await runOnce({
      store,
      notifier,
      portals: [portal],
      withPage: withPageStub,
      portalDepsFor,
      now: new Date('2026-05-15T09:00:00Z'),
      force: false,
    });

    expect(portal.submit).not.toHaveBeenCalled();
  });

  it('records failure with screenshot and notifies', async () => {
    const portal = makePortal({
      submit: vi.fn(async () => {
        throw new Error('TimeoutError');
      }),
    });
    const notifier = makeNotifier();

    await runOnce({
      store,
      notifier,
      portals: [portal],
      withPage: withPageStub,
      portalDepsFor,
      now: new Date('2026-05-15T09:00:00Z'),
      force: false,
    });

    const row = store.getOrCreate('tgc1', '2026-05');
    expect(row.status).toBe('failed');
    expect(row.attempts).toBe(1);
    expect(row.lastErrorScreenshot).toBe('/data/s.png');
    expect(notifier.calls.failure).toHaveLength(1);
  });

  it('marks blocked after 5 failed attempts', async () => {
    const portal = makePortal({
      submit: vi.fn(async () => {
        throw new Error('TimeoutError');
      }),
    });
    const notifier = makeNotifier();

    // pre-seed 5 prior attempts
    store.getOrCreate('tgc1', '2026-05');
    for (let i = 0; i < 5; i++) {
      store.markFailed('tgc1', '2026-05', 'e', null);
    }

    await runOnce({
      store,
      notifier,
      portals: [portal],
      withPage: withPageStub,
      portalDepsFor,
      now: new Date('2026-05-15T09:00:00Z'),
      force: false,
    });

    expect(portal.submit).not.toHaveBeenCalled();
    expect(store.getOrCreate('tgc1', '2026-05').status).toBe('blocked');
  });

  it('emits windowClosed on the last weekday if still not done, once only', async () => {
    const portal = makePortal({
      submit: vi.fn(async () => {
        throw new Error('e');
      }),
    });
    const notifier = makeNotifier();

    // 2026-05: last weekday in [15,21] is Thu 2026-05-21
    await runOnce({
      store,
      notifier,
      portals: [portal],
      withPage: withPageStub,
      portalDepsFor,
      now: new Date('2026-05-21T09:00:00Z'),
      force: false,
    });
    await runOnce({
      store,
      notifier,
      portals: [portal],
      withPage: withPageStub,
      portalDepsFor,
      now: new Date('2026-05-21T10:00:00Z'),
      force: false,
    });

    expect(notifier.calls.windowClosed).toHaveLength(1);
    expect(store.getOrCreate('tgc1', '2026-05').notifiedWindowClosed).toBe(true);
  });

  it('--force bypasses the targetDay gate and the done check', async () => {
    const portal = makePortal();
    const notifier = makeNotifier();

    store.getOrCreate('tgc1', '2026-05');
    store.markDone('tgc1', '2026-05', READINGS, { accountId: 'ACC', balanceText: 'x' });

    await runOnce({
      store,
      notifier,
      portals: [portal],
      withPage: withPageStub,
      portalDepsFor,
      now: new Date('2026-05-10T09:00:00Z'), // before target
      force: true,
    });

    expect(portal.submit).toHaveBeenCalledOnce();
  });
});
