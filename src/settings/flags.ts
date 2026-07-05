/** Boolean settings are stored as the literal strings '1' / '0'; anything else
 *  (unset, blank, garbage) means "use the default". These two helpers are the
 *  single home for that convention — resolvers pick one by the flag's default. */

/** Opt-in flag: only a stored '1' enables it. */
export function flagDefaultOff(value: string | undefined): boolean {
  return value === '1';
}

/** On-by-default flag: only a stored '0' disables it. */
export function flagDefaultOn(value: string | undefined): boolean {
  return value !== '0';
}
