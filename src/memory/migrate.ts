import type Database from 'better-sqlite3';
import { MIGRATIONS } from './migrations.ts';

export function runMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)`);
  const applied = new Set(
    db
      .prepare<[], { version: number }>('SELECT version FROM schema_version')
      .all()
      .map((r) => r.version),
  );
  for (const m of [...MIGRATIONS].sort((a, b) => a.version - b.version)) {
    if (applied.has(m.version)) {
      continue;
    }
    db.exec(m.sql);
  }
}
