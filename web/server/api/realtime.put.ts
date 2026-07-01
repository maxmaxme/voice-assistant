import { setSetting, deleteSetting } from '../utils/db/settings'
import { DbNotReadyError } from '../utils/db/client'
import { REALTIME_KEYS, canonicalizeNumber } from '../utils/realtime'

interface PutBody {
  enabled?: boolean
  // A number-typed <input> serializes filled fields as numbers, blanks as ''.
  outputPacingMs?: string | number
  idleResetMs?: string | number
  followUpMs?: string | number
  requestFollowUpMs?: string | number
  followUpChime?: boolean
  wakeChime?: boolean
}

export default defineEventHandler(async (event) => {
  const body = (await readBody<PutBody>(event)) ?? {}

  // Canonicalize each numeric field up front: a blank clears the key (built-in
  // default), a valid value is stored as a plain integer string, garbage 400s.
  const numbers = [
    ['Output pacing', REALTIME_KEYS.outputPacingMs, body.outputPacingMs],
    ['Idle reset', REALTIME_KEYS.idleResetMs, body.idleResetMs],
    ['Follow-up window', REALTIME_KEYS.followUpMs, body.followUpMs],
    ['Question follow-up window', REALTIME_KEYS.requestFollowUpMs, body.requestFollowUpMs],
  ] as const
  const canonical: Array<[string, string | null]> = []
  for (const [label, key, value] of numbers) {
    const { canonical: c, error } = canonicalizeNumber(label, value)
    if (error) {
      throw createError({ statusCode: 400, statusMessage: error })
    }
    canonical.push([key, c])
  }

  const writeNumber = (key: string, value: string | null): void => {
    if (value === null) deleteSetting(key)
    else setSetting(key, value)
  }

  try {
    if (body.enabled) setSetting(REALTIME_KEYS.enabled, '1')
    else deleteSetting(REALTIME_KEYS.enabled)
    for (const [key, value] of canonical) writeNumber(key, value)
    // Chime defaults to off — persist '1' only to turn it on, else clear the key.
    if (body.followUpChime === true) setSetting(REALTIME_KEYS.followUpChime, '1')
    else deleteSetting(REALTIME_KEYS.followUpChime)
    // Wake beep defaults to on — persist '0' only to turn it off, else clear.
    if (body.wakeChime === false) setSetting(REALTIME_KEYS.wakeChime, '0')
    else deleteSetting(REALTIME_KEYS.wakeChime)
  }
  catch (e) {
    if (e instanceof DbNotReadyError) {
      throw createError({ statusCode: 503, statusMessage: e.message })
    }
    throw e
  }

  return { ok: true, restartRequired: true }
})
