// Realtime (Voice PE) config: DB-only, read/written via /api/realtime (not the
// generic settings env-overlay). KEEP the key strings in sync with
// voice-assistant src/settings/realtimeConfig.ts.

export const REALTIME_KEYS = {
  enabled: 'realtime.enabled',
  outputPacingMs: 'realtime.outputPacingMs',
  idleResetMs: 'realtime.idleResetMs',
} as const

export interface RealtimeForm {
  enabled: boolean
  /** Raw string ('' = use the built-in default), so the UI can leave it blank. */
  outputPacingMs: string
  idleResetMs: string
}

export function readRealtime(all: Record<string, string>): RealtimeForm {
  return {
    enabled: all[REALTIME_KEYS.enabled] === '1',
    outputPacingMs: all[REALTIME_KEYS.outputPacingMs] ?? '',
    idleResetMs: all[REALTIME_KEYS.idleResetMs] ?? '',
  }
}

/** Validate an optional numeric field. Returns an error message, or null. */
export function validateNumber(label: string, value: string | undefined): string | null {
  if (value === undefined || value === '') {
    return null
  }
  if (Number.isNaN(Number(value))) {
    return `${label} must be a number`
  }
  return null
}
