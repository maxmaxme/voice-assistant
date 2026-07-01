import { eq } from 'drizzle-orm';
import type { Db } from '../memory/db.ts';
import { runtimeState } from '../memory/schema.ts';
import type { RuntimeStateStore } from './types.ts';

/** Key under which the running process stamps when it last read the
 *  applied-on-restart config (unix ms). Read by the web panel's config-status. */
export const CONFIG_LOADED_AT = 'config_loaded_at';

export class SqliteRuntimeState implements RuntimeStateStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  get(key: string): string | undefined {
    const row = this.db
      .select({ value: runtimeState.value })
      .from(runtimeState)
      .where(eq(runtimeState.key, key))
      .get();
    return row?.value;
  }

  set(key: string, value: string): void {
    const now = Date.now();
    this.db
      .insert(runtimeState)
      .values({ key, value, updatedAt: now })
      .onConflictDoUpdate({ target: runtimeState.key, set: { value, updatedAt: now } })
      .run();
  }
}
