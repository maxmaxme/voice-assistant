import Database from 'better-sqlite3';
import { runMigrations } from './migrate.ts';
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

  remember(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO profile (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(value), Date.now());
  }

  recall(key?: string): ProfileFacts {
    if (key !== undefined) {
      const row = this.db.prepare('SELECT value FROM profile WHERE key = ?').get(key) as
        | { value: string }
        | undefined;
      if (!row) {
        return {};
      }
      return { [key]: JSON.parse(row.value) };
    }
    const rows = this.db.prepare('SELECT key, value FROM profile').all() as Array<{
      key: string;
      value: string;
    }>;
    const out: ProfileFacts = {};
    for (const r of rows) {
      out[r.key] = JSON.parse(r.value);
    }
    return out;
  }

  forget(key: string): void {
    this.db.prepare('DELETE FROM profile WHERE key = ?').run(key);
  }

  close(): void {
    if (this.ownsDb) {
      this.db.close();
    }
  }
}
