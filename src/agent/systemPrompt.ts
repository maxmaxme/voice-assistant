import type { ProfileFacts } from '../memory/types.ts';
import { getServerTimezone, toLocalIso } from '../utils/time.ts';

/** Append the time/profile context block that the model needs on every
 *  fresh chain (Responses) or session (Realtime). Pure — no `Date.now()`
 *  injection abstraction; both callers already accept "built once per
 *  session" semantics. */
export function appendUserContext(base: string, profile: ProfileFacts): string {
  const nowMs = Date.now();
  const nowUtcIso = new Date(nowMs).toISOString();
  const tzName = getServerTimezone();
  const nowLocal = toLocalIso(nowMs);
  const timeBlock =
    `\n\nCurrent time: ${nowUtcIso} UTC = ${nowLocal} (server timezone: ${tzName}).` +
    ` Unix ms now: ${nowMs}.`;
  if (Object.keys(profile).length === 0) {
    return `${base}${timeBlock}`;
  }
  return `${base}${timeBlock}\n\nKnown user profile: ${JSON.stringify(profile)}`;
}
