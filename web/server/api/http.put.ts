import { setSetting, deleteSetting } from '../utils/db/settings'
import { DbNotReadyError } from '../utils/db/client'
import { HTTP_KEYS, type HttpEndpoint } from '../utils/http'

// Partial update: only the keys present in the body are touched, so the HTTP API
// page (text/audio) and the Assist page (assist) can each PUT just their own.
type PutBody = Partial<Record<HttpEndpoint, boolean>>

export default defineEventHandler(async (event) => {
  const body = (await readBody<PutBody>(event)) ?? {}
  try {
    for (const ep of Object.keys(HTTP_KEYS) as HttpEndpoint[]) {
      if (!(ep in body)) continue
      if (body[ep]) setSetting(HTTP_KEYS[ep], '1')
      else deleteSetting(HTTP_KEYS[ep])
    }
  }
  catch (e) {
    if (e instanceof DbNotReadyError) {
      throw createError({ statusCode: 503, statusMessage: e.message })
    }
    throw e
  }

  return { ok: true, restartRequired: true }
})
