import { setSetting, deleteSetting } from '../utils/db/settings'
import { DbNotReadyError } from '../utils/db/client'
import { REALTIME_KEYS, validateNumber } from '../utils/realtime'

interface PutBody {
  enabled?: boolean
  outputPacingMs?: string
  idleResetMs?: string
  followUpMs?: string
  requestFollowUpMs?: string
  followUpChime?: boolean
  wakeChime?: boolean
}

export default defineEventHandler(async (event) => {
  const body = (await readBody<PutBody>(event)) ?? {}

  for (const [label, value] of [
    ['Output pacing', body.outputPacingMs],
    ['Idle reset', body.idleResetMs],
    ['Follow-up window', body.followUpMs],
    ['Question follow-up window', body.requestFollowUpMs],
  ] as const) {
    const err = validateNumber(label, value)
    if (err) {
      throw createError({ statusCode: 400, statusMessage: err })
    }
  }

  // A blank number reverts to the built-in default — we never persist a blank.
  const writeNumber = (key: string, value: string | undefined): void => {
    if (value === undefined || value === '') deleteSetting(key)
    else setSetting(key, value)
  }

  try {
    if (body.enabled) setSetting(REALTIME_KEYS.enabled, '1')
    else deleteSetting(REALTIME_KEYS.enabled)
    writeNumber(REALTIME_KEYS.outputPacingMs, body.outputPacingMs)
    writeNumber(REALTIME_KEYS.idleResetMs, body.idleResetMs)
    writeNumber(REALTIME_KEYS.followUpMs, body.followUpMs)
    writeNumber(REALTIME_KEYS.requestFollowUpMs, body.requestFollowUpMs)
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
