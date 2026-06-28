import { setSetting, deleteSetting } from '../utils/db/settings'
import { DbNotReadyError } from '../utils/db/client'
import { TELEGRAM_KEYS } from '../utils/telegram'

interface PutBody {
  enabled?: boolean
}

export default defineEventHandler(async (event) => {
  const body = (await readBody<PutBody>(event)) ?? {}
  try {
    if (body.enabled) setSetting(TELEGRAM_KEYS.enabled, '1')
    else deleteSetting(TELEGRAM_KEYS.enabled)
  }
  catch (e) {
    if (e instanceof DbNotReadyError) {
      throw createError({ statusCode: 503, statusMessage: e.message })
    }
    throw e
  }

  return { ok: true, restartRequired: true }
})
