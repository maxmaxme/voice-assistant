import type { Portal, PortalDeps } from './portals/types.ts';
import type { Notifier } from './notify/types.ts';
import type { SubmissionsStore } from './storage/types.ts';
import { currentPeriod } from './period.ts';
import { isInWindow, targetDay, lastWeekdayOfWindow } from './schedule.ts';
import { createLogger } from './logger.ts';
import type { Page } from 'playwright';

const log = createLogger('runOnce');

const MAX_ATTEMPTS = 5;

export interface BrowserSession {
  page: Page;
  screenshotOnFailure(label: string): Promise<string | null>;
}

export interface RunOnceDeps {
  store: SubmissionsStore;
  notifier: Notifier;
  portals: Portal[];
  withPage<T>(_: unknown, fn: (sess: BrowserSession) => Promise<T>): Promise<T>;
  portalDepsFor(portalName: string): PortalDeps;
  now: Date;
  force: boolean;
}

function ymdInMoscow(now: Date): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  return {
    year: Number(parts.find((p) => p.type === 'year')?.value),
    month: Number(parts.find((p) => p.type === 'month')?.value),
    day: Number(parts.find((p) => p.type === 'day')?.value),
  };
}

interface AnnotatedError extends Error {
  screenshotPath: string | null;
}

function annotateError(err: unknown, path: string | null): AnnotatedError {
  const base: Error = err instanceof Error ? err : new Error(String(err));
  return Object.assign(base, { screenshotPath: path });
}

function readScreenshotPath(err: unknown): string | null {
  if (err && typeof err === 'object') {
    const v: unknown = Reflect.get(err, 'screenshotPath');
    if (typeof v === 'string') {
      return v;
    }
  }
  return null;
}

function readMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

export async function runOnce(deps: RunOnceDeps): Promise<void> {
  const { year, month, day } = ymdInMoscow(deps.now);
  const period = currentPeriod(deps.now);
  const target = targetDay(year, month);
  const lastDay = lastWeekdayOfWindow(year, month);

  const beforeTarget = day < target;
  if (beforeTarget && !deps.force) {
    log.info({ today: day, target }, 'before targetDay, exiting');
    return;
  }
  if (!isInWindow(year, month, day) && !deps.force) {
    log.info({ today: day }, 'outside submission window, exiting');
    return;
  }

  for (const portal of deps.portals) {
    const row = deps.store.getOrCreate(portal.name, period);

    if (!deps.force && (row.status === 'done' || row.status === 'blocked')) {
      log.info({ portal: portal.name, status: row.status }, 'skipping, terminal status');
      continue;
    }

    if (!deps.force && row.attempts >= MAX_ATTEMPTS) {
      deps.store.markBlocked(portal.name, period);
      await deps.notifier.failure({
        portal: portal.name,
        period,
        attempt: row.attempts,
        maxAttempts: MAX_ATTEMPTS,
        error: 'Превышен лимит попыток — статус blocked',
        screenshotPath: row.lastErrorScreenshot,
      });
      continue;
    }

    try {
      const { values, info } = await deps.withPage({}, async (sess) => {
        try {
          const info = await portal.fetchAccountInfo(sess.page);
          const values = await portal.submit(sess.page, deps.portalDepsFor(portal.name));
          return { values, info };
        } catch (err) {
          const screenshotPath = await sess.screenshotOnFailure(`${portal.name}-${period}`);
          throw annotateError(err, screenshotPath);
        }
      });

      deps.store.markDone(
        portal.name,
        period,
        values,
        info ?? { accountId: '?', balanceText: '?' },
      );
      await deps.notifier.success({
        portal: portal.name,
        period,
        meterCount: values.length,
        info,
      });
    } catch (err) {
      const screenshotPath = readScreenshotPath(err);
      const message = readMessage(err);
      deps.store.markFailed(portal.name, period, message, screenshotPath);
      const updated = deps.store.getOrCreate(portal.name, period);
      await deps.notifier.failure({
        portal: portal.name,
        period,
        attempt: updated.attempts,
        maxAttempts: MAX_ATTEMPTS,
        error: message,
        screenshotPath,
      });
    }
  }

  // Window-closed notification on the last weekday in [15,21]
  if (day === lastDay) {
    for (const portal of deps.portals) {
      const row = deps.store.getOrCreate(portal.name, period);
      if (row.status !== 'done' && !row.notifiedWindowClosed) {
        await deps.notifier.windowClosed({ portal: portal.name, period });
        deps.store.markWindowClosedNotified(portal.name, period);
      }
    }
  }
}
