import { setSetting, deleteSetting } from '../utils/db/settings'
import { DbNotReadyError } from '../utils/db/client'
import { TOOLS_KEYS } from '../utils/tools'

interface PutBody {
  memory?: boolean
  reminders?: boolean
  weather?: {
    enabled?: boolean
    units?: string
    defaultLocation?: string
  }
}

export default defineEventHandler(async (event) => {
  const body = (await readBody<PutBody>(event)) ?? {}

  // Tools default ON: persist '0' to disable, delete the row to re-enable.
  const writeBool = (key: string, value: boolean | undefined): void => {
    if (value === undefined) return
    if (value) deleteSetting(key)
    else setSetting(key, '0')
  }

  try {
    writeBool(TOOLS_KEYS.memory, body.memory)
    writeBool(TOOLS_KEYS.reminders, body.reminders)
    if (body.weather) {
      writeBool(TOOLS_KEYS.weather, body.weather.enabled)
      // metric is the default → store only the imperial override.
      if (body.weather.units !== undefined) {
        if (body.weather.units === 'imperial') setSetting(TOOLS_KEYS.weatherUnits, 'imperial')
        else deleteSetting(TOOLS_KEYS.weatherUnits)
      }
      if (body.weather.defaultLocation !== undefined) {
        const loc = body.weather.defaultLocation.trim()
        if (loc) setSetting(TOOLS_KEYS.weatherLocation, loc)
        else deleteSetting(TOOLS_KEYS.weatherLocation)
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
