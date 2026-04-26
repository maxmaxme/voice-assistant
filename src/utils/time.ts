/** Time/timezone utilities shared by the agent core and scheduled-action tools.
 *
 * The voice assistant talks to an LLM that is bad at timezone arithmetic, so
 * we keep one canonical pair of helpers:
 *
 *   • `toLocalIso(ms)` — format a UTC epoch as a wall-clock string in the
 *     server's local TZ, including the offset. Used everywhere we surface a
 *     time back to the LLM (system prompt, tool responses).
 *   • `parseLocalWallClock(s)` — inverse: parse a wall-clock string in the
 *     server's TZ into a UTC epoch. Used by `schedule_action` for once-kind
 *     wall-clock times.
 *
 * Both rely on `process.env.TZ` (or the system TZ when unset) at call time.
 */

/** IANA timezone name the process is running in (e.g. "Europe/Madrid"). */
export function getServerTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** Format a UTC epoch ms as a wall-clock string in the server's local
 * timezone, including the offset.
 *
 * Example (TZ=Europe/Madrid, summer): `1777220268296` → `"2026-04-26 18:17:48 GMT+02:00"`.
 *
 * Uses the Swedish (`sv-SE`) locale because it natively formats dates as
 * `YYYY-MM-DD HH:mm:ss`, which is the closest standard locale to ISO 8601.
 * `longOffset` appends the UTC offset (`GMT±HH:MM`) so the LLM sees both
 * local time and the offset in one string. */
export function toLocalIso(ms: number): string {
  const tz = getServerTimezone();
  return new Intl.DateTimeFormat('sv-SE', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: tz,
    timeZoneName: 'longOffset',
  })
    .format(new Date(ms))
    .replace(',', '');
}

/** Parse a wall-clock string in the server's local TZ into a UTC epoch ms.
 *
 * Accepts `"YYYY-MM-DD HH:mm"` or `"YYYY-MM-DD HH:mm:ss"` (space or `T`
 * separator). The string MUST NOT include a timezone offset — the server's
 * TZ (`process.env.TZ` / system) is implicit.
 *
 * Throws on malformed input.
 *
 * Implementation note: we lean on JS `Date` parsing — an ISO-shaped string
 * without an offset is interpreted as local time per ECMAScript §21.4.1.15. */
export function parseLocalWallClock(raw: string): number {
  const s = raw.trim().replace(' ', 'T');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(s)) {
    throw new Error(
      `invalid wall-clock format "${raw}", expected "YYYY-MM-DD HH:mm" or "YYYY-MM-DD HH:mm:ss"`,
    );
  }
  const ms = new Date(s).getTime();
  if (!Number.isFinite(ms)) {
    throw new Error(`failed to parse wall-clock "${raw}"`);
  }
  return ms;
}
