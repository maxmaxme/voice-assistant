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

/** Pin the spoken language for a voice session. Without it the model treats a
 *  non-English household as accented English and mishears them. `language` is
 *  an ISO 639-1 code; '' leaves detection to the model. */
export function appendLanguage(base: string, language: string): string {
  if (!language) {
    return base;
  }
  const name = new Intl.DisplayNames(['en'], { type: 'language' }).of(language) ?? language;
  return `${base}\n\nThe user speaks ${name}. Expect ${name} audio and reply in ${name} unless the user clearly switches to another language.`;
}
