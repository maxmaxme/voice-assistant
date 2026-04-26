export type DueItem =
  | { kind: 'reminder'; id: number; text: string; fireAt: number }
  | { kind: 'timer'; id: number; label: string; fireAt: number; durationMs: number };

export interface FireSink {
  fire(item: DueItem): Promise<void>;
}

/** Schedule for a future action.
 *
 * - `once`: fire a single time at `at` (Unix ms UTC).
 * - `cron`: fire repeatedly per a POSIX 5-field cron expression, evaluated in
 *   the server's timezone (`process.env.TZ` / system TZ), not UTC.
 */
export type Schedule = { kind: 'once'; at: number } | { kind: 'cron'; expr: string };
