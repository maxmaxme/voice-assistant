import Database from 'better-sqlite3';
import { applyMigrations } from './db.ts';
import { SqliteProfileMemory } from './sqliteProfileMemory.ts';
import { SqliteScheduledActions } from './sqliteScheduledActions.ts';
import { SqliteTelegramSessions } from './sqliteTelegramSessions.ts';
import { IdentitiesStore } from './identities.ts';
import { SqliteSettings } from '../settings/sqliteSettings.ts';
import { SqlitePrompts } from '../settings/sqlitePrompts.ts';
import { SqliteIntegrations } from '../integrations/sqliteIntegrations.ts';
import type { MemoryStore } from './types.ts';

export function openMemoryStore(dbPath: string): MemoryStore {
  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  // Tolerate a second process (sqlite-web admin) holding a brief write lock.
  sqlite.pragma('busy_timeout = 5000');
  const db = applyMigrations(sqlite);
  const profile = new SqliteProfileMemory(db);
  const scheduledActions = new SqliteScheduledActions(db);
  const telegramSessions = new SqliteTelegramSessions(db);
  const identities = new IdentitiesStore(db);
  const settings = new SqliteSettings(db);
  const prompts = new SqlitePrompts(db);
  const integrations = new SqliteIntegrations(db);
  return {
    profile,
    profileStore: profile,
    identities,
    scheduledActions,
    telegramSessions,
    settings,
    prompts,
    integrations,
    close() {
      sqlite.close();
    },
  };
}
