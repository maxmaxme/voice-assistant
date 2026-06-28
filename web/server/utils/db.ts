import { resolve } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
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
  const rows = db()
    .prepare(`SELECT type, config, enabled, updated_at AS updatedAt FROM integrations`)
    .all() as RawIntegration[]
  return rows.map(parseIntegration)
}

export function getIntegration(type: string): IntegrationRow | null {
  if (!tableExists('integrations')) {
    return null
  }
  const row = db()
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
  db()
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
    db()
      .prepare(`UPDATE integrations SET enabled = ?, updated_at = ? WHERE type = ?`)
      .run(enabled ? 1 : 0, Date.now(), type).changes > 0
  )
}

export function deleteIntegration(type: string): boolean {
  if (!tableExists('integrations')) {
    throw new DbNotReadyError('integrations')
  }
  return db().prepare(`DELETE FROM integrations WHERE type = ?`).run(type).changes > 0
}

// ── Users & devices (identities) ────────────────────────────────────────────
// voice-assistant owns the `users` + `identities` schema (see src/memory/). We
// only read/write existing rows. Hashing + token generation mirror
// src/memory/identities.ts (sha256) and src/cli/users.ts (randomBytes(24).hex)
// so a device minted here authenticates the same as one made via the CLI.

export type Channel = 'telegram' | 'http' | 'voice'

export interface DeviceRow {
  id: number
  channel: Channel
  /** Raw chatId for telegram; sha256 hash for http/voice (never the token). */
  identity: string
  createdAt: number
  lastUsedAt: number | null
}

export interface UserRow {
  id: number
  name: string
  isAdmin: boolean
  createdAt: number
  devices: DeviceRow[]
}

/** Raised on a UNIQUE(channel, identity) collision so the API can answer 409. */
export class IdentityConflictError extends Error {
  constructor() {
    super('That chat / token is already attached to a user.')
    this.name = 'IdentityConflictError'
  }
}

/** Map a known DB-layer error to an HTTP response; rethrow anything else. */
export function dbErrorToHttp(e: unknown): never {
  if (e instanceof DbNotReadyError) {
    throw createError({ statusCode: 503, statusMessage: e.message })
  }
  if (e instanceof IdentityConflictError) {
    throw createError({ statusCode: 409, statusMessage: e.message })
  }
  throw e
}

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

function genToken(): string {
  return randomBytes(24).toString('hex')
}

function isUniqueViolation(e: unknown): boolean {
  return Boolean(
    e && typeof e === 'object' && 'code' in e
    && String((e as { code: unknown }).code).startsWith('SQLITE_CONSTRAINT'),
  )
}

export function listUsers(): UserRow[] {
  if (!tableExists('users')) {
    return []
  }
  const users = db()
    .prepare(`SELECT id, name, is_admin AS isAdmin, created_at AS createdAt FROM users ORDER BY id`)
    .all() as { id: number, name: string, isAdmin: number, createdAt: number }[]

  const devices = tableExists('identities')
    ? (db()
        .prepare(
          `SELECT id, channel, identity, user_id AS userId,
                  created_at AS createdAt, last_used_at AS lastUsedAt
           FROM identities ORDER BY id`,
        )
        .all() as (DeviceRow & { userId: number })[])
    : []

  const byUser = new Map<number, DeviceRow[]>()
  for (const d of devices) {
    const list = byUser.get(d.userId) ?? []
    list.push({ id: d.id, channel: d.channel, identity: d.identity, createdAt: d.createdAt, lastUsedAt: d.lastUsedAt })
    byUser.set(d.userId, list)
  }

  return users.map(u => ({
    id: u.id,
    name: u.name,
    isAdmin: u.isAdmin === 1,
    createdAt: u.createdAt,
    devices: byUser.get(u.id) ?? [],
  }))
}

export function createUser(name: string, isAdmin: boolean): number {
  if (!tableExists('users')) {
    throw new DbNotReadyError('users')
  }
  const r = db()
    .prepare(`INSERT INTO users (name, created_at, is_admin) VALUES (?, ?, ?)`)
    .run(name, Date.now(), isAdmin ? 1 : 0)
  return Number(r.lastInsertRowid)
}

export function updateUser(id: number, name: string, isAdmin: boolean): boolean {
  if (!tableExists('users')) {
    throw new DbNotReadyError('users')
  }
  return db()
    .prepare(`UPDATE users SET name = ?, is_admin = ? WHERE id = ?`)
    .run(name, isAdmin ? 1 : 0, id).changes > 0
}

/** Delete a user and all its devices in one transaction (FK enforcement is off
 *  on this connection, so we clear identities explicitly rather than rely on
 *  ON DELETE CASCADE). */
export function deleteUser(id: number): boolean {
  if (!tableExists('users')) {
    throw new DbNotReadyError('users')
  }
  const tx = db().transaction((uid: number): number => {
    if (tableExists('identities')) {
      db().prepare(`DELETE FROM identities WHERE user_id = ?`).run(uid)
    }
    return db().prepare(`DELETE FROM users WHERE id = ?`).run(uid).changes
  })
  return tx(id) > 0
}

/** Attach a device. telegram → chatId stored as-is; voice → sha256(token);
 *  http → a fresh token is minted, hashed, and returned once (never stored). */
export function addDevice(userId: number, channel: Channel, value: string): { token?: string } {
  if (!tableExists('identities')) {
    throw new DbNotReadyError('identities')
  }
  let identity: string
  let token: string | undefined
  if (channel === 'telegram') {
    identity = value.trim()
  }
  else if (channel === 'voice') {
    identity = hashToken(value.trim())
  }
  else {
    token = genToken()
    identity = hashToken(token)
  }
  try {
    db()
      .prepare(`INSERT INTO identities (channel, identity, user_id, created_at) VALUES (?, ?, ?, ?)`)
      .run(channel, identity, userId, Date.now())
  }
  catch (e) {
    if (isUniqueViolation(e)) throw new IdentityConflictError()
    throw e
  }
  return { token }
}

/** Edit a device's value in place. telegram → new chatId; voice → re-hash the
 *  new token. http hashes can't be edited (use remintDevice). Returns false if
 *  the row is gone. */
export function updateDevice(id: number, value: string): boolean {
  if (!tableExists('identities')) {
    throw new DbNotReadyError('identities')
  }
  const row = db().prepare(`SELECT channel FROM identities WHERE id = ?`).get(id) as
    | { channel: Channel }
    | undefined
  if (!row) {
    return false
  }
  if (row.channel === 'http') {
    throw createError({
      statusCode: 400,
      statusMessage: 'HTTP tokens cannot be edited in place — re-mint instead.',
    })
  }
  const identity = row.channel === 'voice' ? hashToken(value.trim()) : value.trim()
  try {
    return db().prepare(`UPDATE identities SET identity = ? WHERE id = ?`).run(identity, id).changes > 0
  }
  catch (e) {
    if (isUniqueViolation(e)) throw new IdentityConflictError()
    throw e
  }
}

/** Issue a new http token for an existing http device, returning it once. Null
 *  if the row is absent or not an http device. */
export function remintDevice(id: number): { token: string } | null {
  if (!tableExists('identities')) {
    throw new DbNotReadyError('identities')
  }
  const row = db().prepare(`SELECT channel FROM identities WHERE id = ?`).get(id) as
    | { channel: Channel }
    | undefined
  if (!row || row.channel !== 'http') {
    return null
  }
  const token = genToken()
  db().prepare(`UPDATE identities SET identity = ? WHERE id = ?`).run(hashToken(token), id)
  return { token }
}

export function deleteDevice(id: number): boolean {
  if (!tableExists('identities')) {
    throw new DbNotReadyError('identities')
  }
  return db().prepare(`DELETE FROM identities WHERE id = ?`).run(id).changes > 0
}
