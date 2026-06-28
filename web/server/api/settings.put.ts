import { deleteSetting, setSetting, DbNotReadyError } from '../utils/db'
import { validateSetting } from '../utils/settable'

interface PutBody {
  values?: Record<string, string>
}

export default defineEventHandler(async (event) => {
  const body = await readBody<PutBody>(event)
  const values = body?.values
  if (!values || typeof values !== 'object') {
    throw createError({ statusCode: 400, statusMessage: 'Expected { values: { KEY: value } }' })
  }

  for (const [key, value] of Object.entries(values)) {
    const err = validateSetting(key, value)
    if (err) {
      throw createError({ statusCode: 400, statusMessage: err })
    }
  }

  try {
    for (const [key, value] of Object.entries(values)) {
      // An empty value reverts the key to its env/default — we never persist a
      // blank override, which for a free-text key would wipe the real default.
      if (value === '') {
        deleteSetting(key)
      }
      else {
        setSetting(key, value)
      }
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
