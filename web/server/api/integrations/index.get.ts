import { listIntegrations } from '../../utils/db'
import { INTEGRATIONS, INTEGRATION_BY_TYPE, maskConfig, publicDef } from '../../utils/integrations'

export default defineEventHandler(() => {
  const rows = listIntegrations()
  const byType = new Map(rows.map(r => [r.type, r]))

  const installed = []
  for (const row of rows) {
    const def = INTEGRATION_BY_TYPE.get(row.type)
    if (!def) continue // unknown type (catalog removed) — skip in UI
    installed.push({
      def: publicDef(def),
      ...maskConfig(def, row.config),
      enabled: row.enabled,
      updatedAt: row.updatedAt,
    })
  }
  const available = INTEGRATIONS.filter(def => !byType.has(def.type)).map(publicDef)
  return { installed, available }
})
