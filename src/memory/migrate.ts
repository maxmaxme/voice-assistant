import type Database from 'better-sqlite3';
import { MIGRATIONS } from './migrations.ts';

export function runMigrations(db: Database.Database): void {
  for (const m of [...MIGRATIONS].sort((a, b) => a.version - b.version)) {
    db.exec(m.sql);
  }
}
