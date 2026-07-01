// Realtime (Voice PE) config: DB-only, read/written via /api/realtime (not the
// generic settings env-overlay). KEEP the key strings in sync with
// voice-assistant src/settings/realtimeConfig.ts.

export const REALTIME_KEYS = {
  enabled: 'realtime.enabled',
  outputPacingMs: 'realtime.outputPacingMs',
  idleResetMs: 'realtime.idleResetMs',
  followUpMs: 'realtime.followUpMs',
  requestFollowUpMs: 'realtime.requestFollowUpMs',
  followUpChime: 'realtime.followUpChime',
  wakeChime: 'realtime.wakeChime',
} as const

export interface RealtimeForm {
  enabled: boolean
  /** Raw string ('' = use the built-in default), so the UI can leave it blank. */
  outputPacingMs: string
  idleResetMs: string
  followUpMs: string
  requestFollowUpMs: string
  followUpChime: boolean
  wakeChime: boolean
}

export function readRealtime(all: Record<string, string>): RealtimeForm {
  return {
    enabled: all[REALTIME_KEYS.enabled] === '1',
    outputPacingMs: all[REALTIME_KEYS.outputPacingMs] ?? '',
    idleResetMs: all[REALTIME_KEYS.idleResetMs] ?? '',
    followUpMs: all[REALTIME_KEYS.followUpMs] ?? '',
    requestFollowUpMs: all[REALTIME_KEYS.requestFollowUpMs] ?? '',
    // Default off: only a stored '1' turns the chime on.
    followUpChime: all[REALTIME_KEYS.followUpChime] === '1',
    // Default on: only a stored '0' turns the wake beep off.
    wakeChime: all[REALTIME_KEYS.wakeChime] !== '0',
  }
}

/**
 * Validate + canonicalize an optional numeric field so the DB only ever stores
 * plain integer strings. Accepts a locale decimal comma (e.g. "4000,0" from a
 * number input in a comma-locale browser) and rounds to an integer; a blank
 * value canonicalizes to null (= clear the key, use the built-in default).
 * Doing this server-side protects every client and keeps commas out of storage
 * — the runtime `num()` reader would otherwise silently fall back to the
 * default on a value it can't parse. Returns the canonical value or an error.
 */
export function canonicalizeNumber(
  label: string,
  value: string | number | undefined,
): { canonical: string | null, error: string | null } {
  // A number-typed <input> yields a real number for filled fields and '' when
  // cleared, so the value arrives as string | number over the wire.
  if (value === undefined || (typeof value === 'string' && value.trim() === '')) {
    return { canonical: null, error: null }
  }
  const n = typeof value === 'number' ? value : Number(value.replace(',', '.'))
  if (!Number.isFinite(n)) {
    return { canonical: null, error: `${label} must be a number` }
  }
  return { canonical: String(Math.round(n)), error: null }
}
