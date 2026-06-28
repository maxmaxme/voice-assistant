import { setSetting, deleteSetting, DbNotReadyError } from '../utils/db'
import { REALTIME_KEYS, validateNumber } from '../utils/realtime'

interface PutBody {
  enabled?: boolean
  outputPacingMs?: string
  idleResetMs?: string
}

export default defineEventHandler(async (event) => {
  const body = (await readBody<PutBody>(event)) ?? {}

  for (const [label, value] of [
    ['Output pacing', body.outputPacingMs],
    ['Idle reset', body.idleResetMs],
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
  }
  catch (e) {
    if (e instanceof DbNotReadyError) {
      throw createError({ statusCode: 503, statusMessage: e.message })
    }
    throw e
  }

  return { ok: true, restartRequired: true }
})
