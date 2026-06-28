import { getAllSettings } from '../utils/db/settings'
import { SETTABLE_KEYS, SETTABLE_BY_KEY } from '../utils/settable'

export default defineEventHandler(() => {
  const stored = getAllSettings()
  const values: Record<string, string> = {}
  for (const [k, v] of Object.entries(stored)) {
    if (SETTABLE_BY_KEY.has(k)) {
      values[k] = v
    }
  }
  return { settable: SETTABLE_KEYS, values }
})
