import { getDb, tableExists, DbNotReadyError } from './client'

export interface IntegrationRow {
  type: string
  config: Record<string, string>
  enabled: boolean
  updatedAt: number
}

interface RawIntegration {
  type: string
  config: string
  enabled: number
  updatedAt: number
}

function parseIntegration(r: RawIntegration): IntegrationRow {
  return { type: r.type, config: JSON.parse(r.config), enabled: r.enabled === 1, updatedAt: r.updatedAt }
}

export function listIntegrations(): IntegrationRow[] {
  if (!tableExists('integrations')) {
    return []
  }
  const rows = getDb()
    .prepare(`SELECT type, config, enabled, updated_at AS updatedAt FROM integrations`)
    .all() as RawIntegration[]
  return rows.map(parseIntegration)
}

export function getIntegration(type: string): IntegrationRow | null {
  if (!tableExists('integrations')) {
    return null
  }
  const row = getDb()
    .prepare(`SELECT type, config, enabled, updated_at AS updatedAt FROM integrations WHERE type = ?`)
    .get(type) as RawIntegration | undefined
  return row ? parseIntegration(row) : null
}

// Insert leaves `enabled` at its column default (1); on edit we update config
// only, never clobbering the enabled flag.
export function upsertIntegration(type: string, config: Record<string, string>): void {
  if (!tableExists('integrations')) {
    throw new DbNotReadyError('integrations')
  }
  getDb()
    .prepare(
      `INSERT INTO integrations (type, config, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(type) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at`,
    )
    .run(type, JSON.stringify(config), Date.now())
}

export function setIntegrationEnabled(type: string, enabled: boolean): boolean {
  if (!tableExists('integrations')) {
    throw new DbNotReadyError('integrations')
  }
  return (
    getDb()
      .prepare(`UPDATE integrations SET enabled = ?, updated_at = ? WHERE type = ?`)
      .run(enabled ? 1 : 0, Date.now(), type).changes > 0
  )
}

export function deleteIntegration(type: string): boolean {
  if (!tableExists('integrations')) {
    throw new DbNotReadyError('integrations')
  }
  return getDb().prepare(`DELETE FROM integrations WHERE type = ?`).run(type).changes > 0
}
