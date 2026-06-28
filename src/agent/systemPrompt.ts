import type { ProfileFacts } from '../memory/types.ts';

/** Append the profile context block to a base prompt. The current time is NOT
 *  injected here on purpose — a prompt is built once per chain/session, so a
 *  baked-in clock goes stale; the agent reads "now" on demand via the
 *  `get_current_time` tool instead. */
export function appendUserContext(base: string, profile: ProfileFacts): string {
  if (Object.keys(profile).length === 0) {
    return base;
  }
  return `${base}\n\nKnown user profile: ${JSON.stringify(profile)}`;
}
