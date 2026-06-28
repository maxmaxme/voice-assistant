import { resolve } from 'node:path'
import Database from 'better-sqlite3'

let handle: Database.Database | null = null

/** Open (once) the SQLite DB shared with voice-assistant. voice-assistant owns
 *  the schema + migrations; this app never migrates — it only reads/writes the
 *  `settings` and `prompts` tables, which may not exist yet if voice-assistant
 *  has not run against a fresh DB. */
function db(): Database.Database {
  if (handle) {
    return handle
  }
  // Read VA_DB_PATH straight from the runtime env (not baked runtimeConfig,
  // which Nuxt only overrides via the NUXT_-prefixed name), so ops can point at
  // the bind-mounted DB without a rebuild.
  const configured = process.env.VA_DB_PATH || useRuntimeConfig().vaDbPath
  const path = resolve(process.cwd(), configured)
  const sqlite = new Database(path)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('busy_timeout = 5000')
  handle = sqlite
  return sqlite
}

function tableExists(name: string): boolean {
  const row = db()
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(name)
  return Boolean(row)
}

/** Thrown when voice-assistant has not yet created the config tables. */
export class DbNotReadyError extends Error {
  constructor(table: string) {
    super(
      `The '${table}' table does not exist yet. Start the voice-assistant process once `
      + `against this database so it can run its migrations.`,
    )
    this.name = 'DbNotReadyError'
  }
}

export function getAllSettings(): Record<string, string> {
  if (!tableExists('settings')) {
    return {}
  }
  const rows = db().prepare(`SELECT key, value FROM settings`).all() as {
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
  db()
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
  db().prepare(`DELETE FROM settings WHERE key = ?`).run(key)
}

export interface PromptRow {
  name: string
  content: string
  defaultContent: string
  updatedAt: number
}

export function listPrompts(): PromptRow[] {
  if (!tableExists('prompts')) {
    return []
  }
  return db()
    .prepare(
      `SELECT name, content, default_content AS defaultContent, updated_at AS updatedAt
       FROM prompts ORDER BY name`,
    )
    .all() as PromptRow[]
}

export function getPrompt(name: string): PromptRow | null {
  if (!tableExists('prompts')) {
    return null
  }
  const row = db()
    .prepare(
      `SELECT name, content, default_content AS defaultContent, updated_at AS updatedAt
       FROM prompts WHERE name = ?`,
    )
    .get(name) as PromptRow | undefined
  return row ?? null
}

export function setPrompt(name: string, content: string): void {
  if (!tableExists('prompts')) {
    throw new DbNotReadyError('prompts')
  }
  db()
    .prepare(
      `INSERT INTO prompts (name, content, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`,
    )
    .run(name, content, Date.now())
}

/** Restore a prompt's content from its stored default. Returns false if absent.
 *  voice-assistant refreshes default_content from the bundled .md on each start,
 *  so this app never needs the image files to reset. */
export function resetPrompt(name: string): boolean {
  if (!tableExists('prompts')) {
    throw new DbNotReadyError('prompts')
  }
  const result = db()
    .prepare(`UPDATE prompts SET content = default_content, updated_at = ? WHERE name = ?`)
    .run(Date.now(), name)
  return result.changes > 0
}
