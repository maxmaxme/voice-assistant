// voice-assistant owns the `users` + `identities` schema (see src/memory/). We
// only read/write existing rows. Hashing + token generation mirror
// src/memory/identities.ts (sha256) and src/cli/users.ts (randomBytes(24).hex)
// so a device minted here authenticates the same as one made via the CLI.
import { createHash, randomBytes } from 'node:crypto'
import { getDb, tableExists, DbNotReadyError } from './client'

export type Channel = 'telegram' | 'http' | 'voice'

export interface DeviceRow {
  id: number
  channel: Channel
  /** Raw chatId for telegram; sha256 hash for http/voice (never the token). */
  identity: string
  label: string | null
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

/** Raised when a device targets a user id that doesn't exist (e.g. deleted in
 *  another tab, or the DB was hand-edited) so the API can answer 404. */
export class UserNotFoundError extends Error {
  constructor() {
    super('That user does not exist.')
    this.name = 'UserNotFoundError'
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
  if (e instanceof UserNotFoundError) {
    throw createError({ statusCode: 404, statusMessage: e.message })
  }
  throw e
}

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

function genToken(): string {
  return randomBytes(24).toString('hex')
}

// Exact code, not a SQLITE_CONSTRAINT prefix match: a FOREIGN KEY violation
// also carries that prefix and must not surface as "already attached".
function isUniqueViolation(e: unknown): boolean {
  return Boolean(
    e && typeof e === 'object' && 'code' in e
    && (e as { code: unknown }).code === 'SQLITE_CONSTRAINT_UNIQUE',
  )
}

export function listUsers(): UserRow[] {
  if (!tableExists('users')) {
    return []
  }
  const users = getDb()
    .prepare(`SELECT id, name, is_admin AS isAdmin, created_at AS createdAt FROM users ORDER BY id`)
    .all() as { id: number, name: string, isAdmin: number, createdAt: number }[]

  const devices = tableExists('identities')
    ? (getDb()
        .prepare(
          `SELECT id, channel, identity, label, user_id AS userId,
                  created_at AS createdAt, last_used_at AS lastUsedAt
           FROM identities ORDER BY id`,
        )
        .all() as (DeviceRow & { userId: number })[])
    : []

  const byUser = new Map<number, DeviceRow[]>()
  for (const d of devices) {
    const list = byUser.get(d.userId) ?? []
    list.push({ id: d.id, channel: d.channel, identity: d.identity, label: d.label, createdAt: d.createdAt, lastUsedAt: d.lastUsedAt })
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
  const r = getDb()
    .prepare(`INSERT INTO users (name, created_at, is_admin) VALUES (?, ?, ?)`)
    .run(name, Date.now(), isAdmin ? 1 : 0)
  return Number(r.lastInsertRowid)
}

export function updateUser(id: number, name: string, isAdmin: boolean): boolean {
  if (!tableExists('users')) {
    throw new DbNotReadyError('users')
  }
  return getDb()
    .prepare(`UPDATE users SET name = ?, is_admin = ? WHERE id = ?`)
    .run(name, isAdmin ? 1 : 0, id).changes > 0
}

/** Delete a user and all its devices in one transaction, child rows first —
 *  the identities FK is declared ON DELETE no action, so with foreign_keys ON
 *  deleting the user before its identities would be rejected. */
export function deleteUser(id: number): boolean {
  if (!tableExists('users')) {
    throw new DbNotReadyError('users')
  }
  const tx = getDb().transaction((uid: number): number => {
    if (tableExists('identities')) {
      getDb().prepare(`DELETE FROM identities WHERE user_id = ?`).run(uid)
    }
    return getDb().prepare(`DELETE FROM users WHERE id = ?`).run(uid).changes
  })
  return tx(id) > 0
}

/** Attach a device. telegram → chatId stored as-is; voice/http → sha256(token).
 *  For http/voice a blank value means "generate a random token", which is
 *  returned once (never stored); a supplied token is hashed. */
export function addDevice(userId: number, channel: Channel, value: string, label = ''): { token?: string } {
  if (!tableExists('identities')) {
    throw new DbNotReadyError('identities')
  }
  // Friendly 404 instead of the raw SQLITE_CONSTRAINT_FOREIGNKEY the FK
  // would throw (the user may have been deleted in another tab).
  const userRow = getDb().prepare(`SELECT id FROM users WHERE id = ?`).get(userId)
  if (!userRow) {
    throw new UserNotFoundError()
  }
  const trimmed = value.trim()
  let identity: string
  let token: string | undefined
  if (channel === 'telegram') {
    identity = trimmed
  }
  else if ((channel === 'http' || channel === 'voice') && !trimmed) {
    token = genToken()
    identity = hashToken(token)
  }
  else {
    // http/voice with a user-supplied token.
    identity = hashToken(trimmed)
  }
  try {
    getDb()
      .prepare(`INSERT INTO identities (channel, identity, label, user_id, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(channel, identity, label.trim() || null, userId, Date.now())
  }
  catch (e) {
    if (isUniqueViolation(e)) throw new IdentityConflictError()
    throw e
  }
  return { token }
}

/** Edit a device in place. telegram → new chatId; voice/http → re-hash the
 *  supplied token (or use remintDevice to generate a random one). A blank
 *  value keeps the current identity, so the label can be edited on its own;
 *  an undefined label leaves the label untouched.
 *  Returns false if the row is gone. */
export function updateDevice(id: number, value: string, label?: string): boolean {
  if (!tableExists('identities')) {
    throw new DbNotReadyError('identities')
  }
  const row = getDb().prepare(`SELECT channel FROM identities WHERE id = ?`).get(id) as
    | { channel: Channel }
    | undefined
  if (!row) {
    return false
  }
  const trimmed = value.trim()
  const sets: string[] = []
  const params: (string | null)[] = []
  if (trimmed) {
    sets.push('identity = ?')
    params.push(row.channel === 'telegram' ? trimmed : hashToken(trimmed))
  }
  if (label !== undefined) {
    sets.push('label = ?')
    params.push(label.trim() || null)
  }
  if (!sets.length) {
    return true
  }
  try {
    return getDb()
      .prepare(`UPDATE identities SET ${sets.join(', ')} WHERE id = ?`)
      .run(...params, id).changes > 0
  }
  catch (e) {
    if (isUniqueViolation(e)) throw new IdentityConflictError()
    throw e
  }
}

/** Issue a new token for an existing http/voice device, returning it once. Null
 *  if the row is absent or a telegram device (its identity is a raw chat id). */
export function remintDevice(id: number): { token: string } | null {
  if (!tableExists('identities')) {
    throw new DbNotReadyError('identities')
  }
  const row = getDb().prepare(`SELECT channel FROM identities WHERE id = ?`).get(id) as
    | { channel: Channel }
    | undefined
  if (!row || row.channel === 'telegram') {
    return null
  }
  const token = genToken()
  getDb().prepare(`UPDATE identities SET identity = ? WHERE id = ?`).run(hashToken(token), id)
  return { token }
}

export function deleteDevice(id: number): boolean {
  if (!tableExists('identities')) {
    throw new DbNotReadyError('identities')
  }
  return getDb().prepare(`DELETE FROM identities WHERE id = ?`).run(id).changes > 0
}
