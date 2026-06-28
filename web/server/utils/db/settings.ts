import { getDb, tableExists, DbNotReadyError } from './client'

export function getAllSettings(): Record<string, string> {
  if (!tableExists('settings')) {
    return {}
  }
  const rows = getDb().prepare(`SELECT key, value FROM settings`).all() as {
    key: string
    value: string
  }[]
  const out: Record<string, string> = {}
  for (const r of rows) {
    out[r.key] = r.value
  }
  return out
}

export function setSetting(key: string, value: string): void {
  if (!tableExists('settings')) {
    throw new DbNotReadyError('settings')
  }
  getDb()
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(key, value, Date.now())
}

export function deleteSetting(key: string): void {
  if (!tableExists('settings')) {
    throw new DbNotReadyError('settings')
  }
  getDb().prepare(`DELETE FROM settings WHERE key = ?`).run(key)
}
