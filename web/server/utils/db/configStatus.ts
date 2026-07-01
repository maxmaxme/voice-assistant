import { getDb, tableExists } from './client'

// The three tables voice-assistant only re-reads on restart. A live edit to any
// of them bumps its `updated_at`; the newest across all three is "last edit".
const APPLIED_ON_RESTART_TABLES = ['settings', 'prompts', 'integrations'] as const

/** Newest `updated_at` (unix ms) across the applied-on-restart tables, or null
 *  if none exist yet / are empty. */
export function getLastEditAt(): number | null {
  const parts = APPLIED_ON_RESTART_TABLES.filter(tableExists).map(
    t => `SELECT MAX(updated_at) AS m FROM ${t}`,
  )
  if (parts.length === 0) {
    return null
  }
  const row = getDb()
    .prepare(`SELECT MAX(m) AS m FROM (${parts.join(' UNION ALL ')})`)
    .get() as { m: number | null } | undefined
  return row?.m ?? null
}
