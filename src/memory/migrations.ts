export interface Migration {
  version: number;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY
      );
      CREATE TABLE IF NOT EXISTS profile (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO schema_version (version) VALUES (1);
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS kv (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO schema_version (version) VALUES (2);
    `,
  },
  {
    version: 3,
    sql: `
      CREATE TABLE IF NOT EXISTS reminders (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        text           TEXT NOT NULL,
        fire_at        INTEGER NOT NULL,
        repeat_pattern TEXT,
        status         TEXT NOT NULL DEFAULT 'pending',
        created_at     INTEGER NOT NULL,
        fired_at       INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_reminders_due
        ON reminders(fire_at) WHERE status = 'pending';

      CREATE TABLE IF NOT EXISTS timers (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        label       TEXT NOT NULL,
        fire_at     INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        status      TEXT NOT NULL DEFAULT 'active',
        created_at  INTEGER NOT NULL,
        fired_at    INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_timers_due
        ON timers(fire_at) WHERE status = 'active';

      INSERT OR IGNORE INTO schema_version (version) VALUES (3);
    `,
  },
];
