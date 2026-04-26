/** Cron utilities for the unified `Schedule` union.
 *
 * Cron expressions use the POSIX 5-field form (`minute hour day-of-month
 * month day-of-week`) and are evaluated in the server's timezone — see
 * `getServerTimezone()` — so that a user saying "каждый день в 8 утра"
 * fires at 08:00 local, regardless of whether the host (or container) is
 * UTC.
 *
 * Backed by `cron-parser` v5 (`CronExpressionParser.parse`).
 */

import { CronExpressionParser } from 'cron-parser';
import type { Schedule } from './types.ts';
import { getServerTimezone } from '../utils/time.ts';

const CRON_HINT = 'expected POSIX 5-field cron: "minute hour day-of-month month day-of-week"';

/** Validate a Schedule.
 *
 * No-op for `once`. For `cron`, throws an `Error` with a friendly message
 * (mentioning the expression and the canonical 5-field hint, plus the
 * underlying parser error if available). */
export function validateSchedule(s: Schedule): void {
  if (s.kind === 'once') {
    return;
  }
  try {
    CronExpressionParser.parse(s.expr, { tz: getServerTimezone() });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`invalid cron expression "${s.expr}": ${detail} (${CRON_HINT})`, {
      cause: err,
    });
  }
}

/** Compute the next fire instant (Unix ms UTC) for a Schedule.
 *
 * - `once`: returns `s.at` verbatim — the schedule has a single fire time
 *   regardless of `now`.
 * - `cron`: returns the next firing strictly after `now`, evaluated in the
 *   server's timezone.
 *
 * Throws (via `validateSchedule`) if the cron expression is invalid. */
export function nextFireAt(s: Schedule, now: number): number {
  if (s.kind === 'once') {
    return s.at;
  }
  let expr;
  try {
    expr = CronExpressionParser.parse(s.expr, {
      tz: getServerTimezone(),
      currentDate: new Date(now),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`invalid cron expression "${s.expr}": ${detail} (${CRON_HINT})`, {
      cause: err,
    });
  }
  return expr.next().getTime();
}
