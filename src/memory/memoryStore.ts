import Database from 'better-sqlite3';
import { runMigrations } from './migrate.ts';
import { SqliteProfileMemory } from './sqliteProfileMemory.ts';
import { SqliteScheduledActions } from './sqliteScheduledActions.ts';
import type { MemoryStore } from './types.ts';

export function openMemoryStore(dbPath: string): MemoryStore {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  runMigrations(db);
  const profile = new SqliteProfileMemory({ db });
  const scheduledActions = new SqliteScheduledActions(db);
  return {
    profile,
    scheduledActions,
    close() {
      db.close();
    },
  };
}
