import type Database from 'better-sqlite3';
import type { OffsetStore } from './offsetStore.ts';

export interface SqliteOffsetStoreOptions {
  db: Database.Database;
  /** kv key, e.g. 'telegram.offset'. */
  key: string;
}

export class SqliteOffsetStore implements OffsetStore {
  private readonly db: Database.Database;
  private readonly key: string;
  private cached: number | null = null;

  constructor(opts: SqliteOffsetStoreOptions) {
    this.db = opts.db;
    this.key = opts.key;
  }

  read(): number {
    if (this.cached !== null) return this.cached;
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(this.key) as
      | { value: string }
      | undefined;
    const v = row ? Number(row.value) : 0;
    this.cached = Number.isFinite(v) ? v : 0;
    return this.cached;
  }

  write(value: number): void {
    const current = this.read();
    if (value <= current) return; // monotonic
    this.db
      .prepare(
        `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(this.key, String(value), Date.now());
    this.cached = value;
  }
}
