import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Channel, IdentitiesAdapter, IdentityResolution, Role } from './types.ts';

/** Full sha256 hex of a bearer/device token. Raw tokens are never stored. */
export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export class IdentitiesStore implements IdentitiesAdapter {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  resolve(channel: Channel, identity: string): IdentityResolution | null {
    const row = this.db
      .prepare<[string, string], { user_id: number; role: Role }>(
        `SELECT i.user_id AS user_id, u.role AS role
           FROM identities i JOIN users u ON u.id = i.user_id
          WHERE i.channel = ? AND i.identity = ?`,
      )
      .get(channel, identity);
    return row ? { userId: row.user_id, role: row.role } : null;
  }

  addUser(name: string, role: Role): number {
    const info = this.db
      .prepare(`INSERT INTO users (name, role, created_at) VALUES (?, ?, ?)`)
      .run(name, role, Date.now());
    return Number(info.lastInsertRowid);
  }

  attachIdentity(channel: Channel, identity: string, userId: number): void {
    this.db
      .prepare(
        `INSERT INTO identities (channel, identity, user_id, created_at) VALUES (?, ?, ?, ?)`,
      )
      .run(channel, identity, userId, Date.now());
  }

  isEmpty(): boolean {
    const row = this.db.prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM identities`).get();
    return row?.n === 0;
  }
}
