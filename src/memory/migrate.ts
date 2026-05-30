import type Database from 'better-sqlite3';
import { MIGRATIONS, type Migration } from './migrations.ts';

/** Apply pending migrations, each wrapped in its own transaction. A migration
 *  that throws is rolled back ENTIRELY (no half-applied schema) and the error
 *  propagates — so an interrupted/failed migration is retried cleanly on the
 *  next open instead of leaving leftovers (e.g. a stray `users_new`) that wedge
 *  every subsequent boot. Each migration's `INSERT ... schema_version` runs in
 *  the same transaction, so a version is recorded iff its migration fully
 *  committed. `migrations` is injectable for testing. */
export function runMigrations(db: Database.Database, migrations: Migration[] = MIGRATIONS): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)`);
  const applied = new Set(
    db
      .prepare<[], { version: number }>('SELECT version FROM schema_version')
      .all()
      .map((r) => r.version),
  );
  for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
    if (applied.has(m.version)) {
      continue;
    }
    db.exec('BEGIN');
    try {
      db.exec(m.sql);
      db.exec('COMMIT');
    } catch (err) {
      // Roll back the partial migration; never let a ROLLBACK error mask the
      // original migration failure (which is what we actually need to see).
      try {
        db.exec('ROLLBACK');
      } catch {
        // ignore
      }
      throw err;
    }
  }
}
