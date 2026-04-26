import Database from 'better-sqlite3';
import { runMigrations } from './migrate.ts';
import { SqliteProfileMemory } from './sqliteProfileMemory.ts';
import { SqliteReminders } from './sqliteReminders.ts';
import { SqliteTimers } from './sqliteTimers.ts';
import type { MemoryStore } from './types.ts';

export function openMemoryStore(dbPath: string): MemoryStore {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  runMigrations(db);
  const profile = new SqliteProfileMemory({ db });
  const reminders = new SqliteReminders(db);
  const timers = new SqliteTimers(db);
  return {
    profile,
    reminders,
    timers,
    close() {
      db.close();
    },
  };
}
