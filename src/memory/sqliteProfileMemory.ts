import { and, eq } from 'drizzle-orm';
import type { Db } from './db.ts';
import { profile } from './schema.ts';
import { HOUSEHOLD_OWNER } from './scope.ts';
import type { MemoryAdapter, ProfileFacts } from './types.ts';
import { createLogger } from '../utils/logger.ts';

const log = createLogger('profile-memory');

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
          const parsed = parseStoredValue(owner, key, row.value);
          if (parsed.ok) {
            out[key] = parsed.value;
          }
        }
      } else {
        const rows = this.db
          .select({ key: profile.key, value: profile.value })
          .from(profile)
          .where(eq(profile.owner, owner))
          .all();
        for (const r of rows) {
          const parsed = parseStoredValue(owner, r.key, r.value);
          if (parsed.ok) {
            out[r.key] = parsed.value;
          }
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

// The DB is also hand-edited via the sqlite-web CRUD UI, so a non-JSON `value`
// is a real scenario. Skip the row rather than surface the raw string: recall
// feeds the model as facts, and skipping also lets an owner earlier in the
// union (e.g. household under a mangled personal row) keep providing the key.
function parseStoredValue(
  owner: string,
  key: string,
  raw: string,
): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    log.warn({ owner, key }, 'skipping corrupt profile row: value is not valid JSON');
    return { ok: false };
  }
}
