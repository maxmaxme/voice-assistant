import { setSetting, deleteSetting } from '../utils/db/settings'
import { DbNotReadyError } from '../utils/db/client'
import { HTTP_KEYS } from '../utils/http'

interface PutBody {
  enabled?: boolean
}

export default defineEventHandler(async (event) => {
  const body = (await readBody<PutBody>(event)) ?? {}
  try {
    if (body.enabled) setSetting(HTTP_KEYS.enabled, '1')
    else deleteSetting(HTTP_KEYS.enabled)
  }
  catch (e) {
    if (e instanceof DbNotReadyError) {
      throw createError({ statusCode: 503, statusMessage: e.message })
    }
    throw e
  }

  return { ok: true, restartRequired: true }
})
