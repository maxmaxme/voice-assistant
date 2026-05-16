import type { Portal, PortalDeps } from './portals/types.ts';
import type { Notifier } from './notify/types.ts';
import type { SubmissionsStore } from './storage/types.ts';
import { currentPeriod } from './period.ts';
import { isInWindow, targetDay, lastWeekdayOfWindow } from './schedule.ts';
import { createLogger } from './logger.ts';

const log = createLogger('runOnce');

const MAX_ATTEMPTS = 5;

export interface RunOnceDeps {
  store: SubmissionsStore;
  notifier: Notifier;
  portals: Portal[];
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

function readMessage(err: unknown): string {
  if (err instanceof Error) {
    // undici-style errors keep the underlying network/TLS reason on `.cause`
    // — surface it so "fetch failed" isn't the whole story we tell.
    const { cause } = err;
    if (cause instanceof Error && cause.message !== '') {
      return `${err.message}: ${cause.message}`;
    }
    if (cause !== undefined && cause !== null) {
      return `${err.message}: ${String(cause)}`;
    }
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
      await safeNotify(() =>
        deps.notifier.failure({
          portal: portal.name,
          period,
          attempt: row.attempts,
          maxAttempts: MAX_ATTEMPTS,
          error: 'Превышен лимит попыток — статус blocked',
        }),
      );
      continue;
    }

    try {
      const { values, info, alreadySubmitted } = await portal.run(deps.portalDepsFor(portal.name));
      deps.store.markDone(
        portal.name,
        period,
        values,
        info ?? { accountId: '?', balanceText: '?' },
      );
      log.info({ portal: portal.name, meters: values.length }, 'portal run succeeded');
      await safeNotify(() =>
        deps.notifier.success({
          portal: portal.name,
          period,
          meterCount: values.length,
          info,
          alreadySubmitted,
        }),
      );
    } catch (err) {
      const message = readMessage(err);
      log.error({ portal: portal.name, err: message }, 'portal run failed');
      deps.store.markFailed(portal.name, period, message);
      const updated = deps.store.getOrCreate(portal.name, period);
      await safeNotify(() =>
        deps.notifier.failure({
          portal: portal.name,
          period,
          attempt: updated.attempts,
          maxAttempts: MAX_ATTEMPTS,
          error: message,
        }),
      );
    }
  }

  // Window-closed notification on the last weekday in [15,21]
  if (day === lastDay) {
    for (const portal of deps.portals) {
      const row = deps.store.getOrCreate(portal.name, period);
      if (row.status !== 'done' && !row.notifiedWindowClosed) {
        await safeNotify(() => deps.notifier.windowClosed({ portal: portal.name, period }));
        deps.store.markWindowClosedNotified(portal.name, period);
      }
    }
  }
}

/**
 * Best-effort notifier wrapper. Notifications must never replace the real
 * portal error in our logs — e.g. when api.telegram.org itself is
 * unreachable, we still want the pesc/tgc1 root cause to survive in stderr
 * and in the submissions store.
 */
async function safeNotify(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    log.warn({ err: readMessage(err) }, 'notifier call failed');
  }
}
