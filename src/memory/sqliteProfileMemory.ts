import Database from 'better-sqlite3';
import { runMigrations } from './migrate.ts';
import { HOUSEHOLD_OWNER } from './scope.ts';
import type { MemoryAdapter, ProfileFacts } from './types.ts';

export type SqliteProfileMemoryOptions =
  | { dbPath: string; db?: undefined }
  | { db: Database.Database; dbPath?: undefined };

export class SqliteProfileMemory implements MemoryAdapter {
  private readonly db: Database.Database;
  private readonly ownsDb: boolean;

  constructor(opts: SqliteProfileMemoryOptions) {
    if (opts.db) {
      this.db = opts.db;
      this.ownsDb = false;
    } else {
      this.db = new Database(opts.dbPath);
      this.db.pragma('journal_mode = WAL');
      this.ownsDb = true;
    }
    runMigrations(this.db);
  }

  rememberFor(owner: string, key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO profile (owner, key, value, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(owner, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(owner, key, JSON.stringify(value), Date.now());
  }

  /** Read the union of `owners`. Owners are applied in order, so a later
   *  owner's value overrides an earlier one's on key collision. */
  recallFor(owners: string[], key?: string): ProfileFacts {
    const out: ProfileFacts = {};
    for (const owner of owners) {
      if (key !== undefined) {
        const row = this.db
          .prepare<
            [string, string],
            { value: string }
          >('SELECT value FROM profile WHERE owner = ? AND key = ?')
          .get(owner, key);
        if (row) {
          out[key] = JSON.parse(row.value);
        }
      } else {
        const rows = this.db
          .prepare<
            [string],
            { key: string; value: string }
          >('SELECT key, value FROM profile WHERE owner = ?')
          .all(owner);
        for (const r of rows) {
          out[r.key] = JSON.parse(r.value);
        }
      }
    }
    return out;
  }

  forgetFor(owner: string, key: string): void {
    this.db.prepare('DELETE FROM profile WHERE owner = ? AND key = ?').run(owner, key);
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
    if (this.ownsDb) {
      this.db.close();
    }
  }
}
