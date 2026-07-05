import { resolve } from 'node:path'
import Database from 'better-sqlite3'

let handle: Database.Database | null = null

/** Open (once) the SQLite DB shared with voice-assistant. voice-assistant owns
 *  the schema + migrations; this app never migrates — it only reads/writes
 *  existing tables, which may not exist yet on a fresh DB voice-assistant has
 *  not run against. The single connection is shared across all db/* modules. */
export function getDb(): Database.Database {
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
  // better-sqlite3 happens to compile SQLite with FKs on, but that's a driver
  // build flag, not a DB property — pin it so identities.user_id → users.id
  // stays enforced regardless of driver build. Mirrors core's memoryStore.ts.
  sqlite.pragma('foreign_keys = ON')
  handle = sqlite
  return sqlite
}

export function tableExists(name: string): boolean {
  const row = getDb()
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(name)
  return Boolean(row)
}

/** Thrown when voice-assistant has not yet created a config table. */
export class DbNotReadyError extends Error {
  constructor(table: string) {
    super(
      `The '${table}' table does not exist yet. Start the voice-assistant process once `
      + `against this database so it can run its migrations.`,
    )
    this.name = 'DbNotReadyError'
  }
}
