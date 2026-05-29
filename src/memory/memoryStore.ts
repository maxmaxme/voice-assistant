import Database from 'better-sqlite3';
import { runMigrations } from './migrate.ts';
import { SqliteProfileMemory } from './sqliteProfileMemory.ts';
import { SqliteScheduledActions } from './sqliteScheduledActions.ts';
import { SqliteTelegramSessions } from './sqliteTelegramSessions.ts';
import { IdentitiesStore } from './identities.ts';
import type { MemoryStore } from './types.ts';

export function openMemoryStore(dbPath: string): MemoryStore {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  // Tolerate a second process (sqlite-web admin) holding a brief write lock.
  db.pragma('busy_timeout = 5000');
  runMigrations(db);
  const profile = new SqliteProfileMemory({ db });
  const scheduledActions = new SqliteScheduledActions(db);
  const telegramSessions = new SqliteTelegramSessions(db);
  const identities = new IdentitiesStore(db);
  return {
    profile,
    profileStore: profile,
    identities,
    scheduledActions,
    telegramSessions,
    close() {
      db.close();
    },
  };
}
