import { getDb, tableExists } from './client'

/** When voice-assistant last read the applied-on-restart config (unix ms), or
 *  null if it has never run against this DB / predates the feature. */
export function getConfigLoadedAt(): number | null {
  if (!tableExists('runtime_state')) {
    return null
  }
  const row = getDb()
    .prepare(`SELECT value FROM runtime_state WHERE key = ?`)
    .get('config_loaded_at') as { value: string } | undefined
  if (!row) {
    return null
  }
  const n = Number(row.value)
  return Number.isFinite(n) ? n : null
}
