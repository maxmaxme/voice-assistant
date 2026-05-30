import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Channel, IdentitiesAdapter, IdentityResolution } from './types.ts';

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
      .prepare<
        [string, string],
        { user_id: number }
      >(`SELECT user_id FROM identities WHERE channel = ? AND identity = ?`)
      .get(channel, identity);
    return row ? { userId: row.user_id } : null;
  }

  identityFor(channel: Channel, userId: number): string | null {
    const row = this.db
      .prepare<
        [string, number],
        { identity: string }
      >(`SELECT identity FROM identities WHERE channel = ? AND user_id = ? ORDER BY id LIMIT 1`)
      .get(channel, userId);
    return row ? row.identity : null;
  }

  addUser(name: string): number {
    const info = this.db
      .prepare(`INSERT INTO users (name, created_at) VALUES (?, ?)`)
      .run(name, Date.now());
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
