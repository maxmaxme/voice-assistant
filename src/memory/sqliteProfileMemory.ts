import { and, eq } from 'drizzle-orm';
import type { Db } from './db.ts';
import { profile } from './schema.ts';
import { HOUSEHOLD_OWNER } from './scope.ts';
import type { MemoryAdapter, ProfileFacts } from './types.ts';

export class SqliteProfileMemory implements MemoryAdapter {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  rememberFor(owner: string, key: string, value: unknown): void {
    const json = JSON.stringify(value);
    const now = Date.now();
    this.db
      .insert(profile)
      .values({ owner, key, value: json, updatedAt: now })
      .onConflictDoUpdate({
        target: [profile.owner, profile.key],
        set: { value: json, updatedAt: now },
      })
      .run();
  }

  /** Read the union of `owners`. Owners are applied in order, so a later
   *  owner's value overrides an earlier one's on key collision. */
  recallFor(owners: string[], key?: string): ProfileFacts {
    const out: ProfileFacts = {};
    for (const owner of owners) {
      if (key !== undefined) {
        const row = this.db
          .select({ value: profile.value })
          .from(profile)
          .where(and(eq(profile.owner, owner), eq(profile.key, key)))
          .get();
        if (row) {
          out[key] = JSON.parse(row.value);
        }
      } else {
        const rows = this.db
          .select({ key: profile.key, value: profile.value })
          .from(profile)
          .where(eq(profile.owner, owner))
          .all();
        for (const r of rows) {
          out[r.key] = JSON.parse(r.value);
        }
      }
    }
    return out;
  }

  forgetFor(owner: string, key: string): void {
    this.db
      .delete(profile)
      .where(and(eq(profile.owner, owner), eq(profile.key, key)))
      .run();
  }

  // --- back-compat MemoryAdapter: household scope ---
  remember(key: string, value: unknown): void {
    this.rememberFor(HOUSEHOLD_OWNER, key, value);
  }

  recall(key?: string): ProfileFacts {
    return this.recallFor([HOUSEHOLD_OWNER], key);
  }

  forget(key: string): void {
    this.forgetFor(HOUSEHOLD_OWNER, key);
  }

  close(): void {
    // DB lifecycle is owned by openMemoryStore (memoryStore.ts); nothing to do.
  }
}
