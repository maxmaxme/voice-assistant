import { createHash } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import type { Db } from './db.ts';
import { identities, users } from './schema.ts';
import type { Channel, IdentitiesAdapter, IdentityResolution } from './types.ts';

/** Full sha256 hex of a bearer/device token. Raw tokens are never stored. */
export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export class IdentitiesStore implements IdentitiesAdapter {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  resolve(channel: Channel, identity: string): IdentityResolution | null {
    const row = this.db
      .select({ userId: identities.userId })
      .from(identities)
      .where(and(eq(identities.channel, channel), eq(identities.identity, identity)))
      .get();
    return row ? { userId: row.userId } : null;
  }

  touch(channel: Channel, identity: string): void {
    this.db
      .update(identities)
      .set({ lastUsedAt: Date.now() })
      .where(and(eq(identities.channel, channel), eq(identities.identity, identity)))
      .run();
  }

  identityFor(channel: Channel, userId: number): string | null {
    const row = this.db
      .select({ identity: identities.identity })
      .from(identities)
      .where(and(eq(identities.channel, channel), eq(identities.userId, userId)))
      .orderBy(asc(identities.id))
      .limit(1)
      .get();
    return row ? row.identity : null;
  }

  listTelegramUsers(): { userId: number; name: string; chatId: string }[] {
    return this.db
      .select({ userId: identities.userId, name: users.name, chatId: identities.identity })
      .from(identities)
      .innerJoin(users, eq(users.id, identities.userId))
      .where(eq(identities.channel, 'telegram'))
      .orderBy(asc(identities.id))
      .all();
  }

  addUser(name: string): number {
    const row = this.db
      .insert(users)
      .values({ name, createdAt: Date.now() })
      .returning({ id: users.id })
      .get();
    return Number(row.id);
  }

  attachIdentity(channel: Channel, identity: string, userId: number): void {
    this.db.insert(identities).values({ channel, identity, userId, createdAt: Date.now() }).run();
  }

  isAdmin(userId: number): boolean {
    const row = this.db
      .select({ isAdmin: users.isAdmin })
      .from(users)
      .where(eq(users.id, userId))
      .get();
    return row?.isAdmin === 1;
  }

  setAdmin(userId: number, isAdmin: boolean): void {
    this.db
      .update(users)
      .set({ isAdmin: isAdmin ? 1 : 0 })
      .where(eq(users.id, userId))
      .run();
  }

  isEmpty(): boolean {
    const row = this.db.select({ id: identities.id }).from(identities).limit(1).get();
    return row === undefined;
  }
}
