import { listIntegrations } from '../../utils/db/integrations'
import { INTEGRATIONS, defFor, maskConfig, publicDef } from '../../utils/integrations'

export default defineEventHandler(() => {
  const rows = listIntegrations()
  const byType = new Map(rows.map(r => [r.type, r]))

  const installed = []
  for (const row of rows) {
    const def = defFor(row.type)
    if (!def) continue // unknown type (catalog removed) — skip in UI
    const pub = publicDef(def)
    installed.push({
      type: row.type,
      // Instances of a multi integration are told apart by their name.
      def: def.multi ? { ...pub, title: `${pub.title}: ${row.config.name ?? row.type}` } : pub,
      ...maskConfig(def, row.config),
      enabled: row.enabled,
      updatedAt: row.updatedAt,
    })
  }
  const available = INTEGRATIONS.filter(def => def.multi || !byType.has(def.type)).map(publicDef)
  return { installed, available }
})
