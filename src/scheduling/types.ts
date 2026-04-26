/** Schedule for a future action.
 *
 * - `once`: fire a single time at `at` (Unix ms UTC).
 * - `cron`: fire repeatedly per a POSIX 5-field cron expression, evaluated in
 *   the server's timezone (`process.env.TZ` / system TZ), not UTC.
 *
 * Cron is stateless — caller stores the last fire instant elsewhere if needed.
 */
export type Schedule = { kind: 'once'; at: number } | { kind: 'cron'; expr: string };
