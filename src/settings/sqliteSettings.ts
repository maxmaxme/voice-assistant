import { eq } from 'drizzle-orm';
import type { Db } from '../memory/db.ts';
import { settings } from '../memory/schema.ts';
import type { SettingsStore } from './types.ts';

export class SqliteSettings implements SettingsStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  get(key: string): string | undefined {
    const row = this.db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, key))
      .get();
    return row?.value;
  }

  getAll(): Record<string, string> {
    const rows = this.db.select({ key: settings.key, value: settings.value }).from(settings).all();
    const out: Record<string, string> = {};
    for (const r of rows) {
      out[r.key] = r.value;
    }
    return out;
  }

  set(key: string, value: string): void {
    const now = Date.now();
    this.db
      .insert(settings)
      .values({ key, value, updatedAt: now })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } })
      .run();
  }

  delete(key: string): void {
    this.db.delete(settings).where(eq(settings.key, key)).run();
  }
}
