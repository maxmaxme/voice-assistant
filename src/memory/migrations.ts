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
  {
    version: 4,
    sql: `
      CREATE TABLE IF NOT EXISTS scheduled_actions (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        goal            TEXT NOT NULL,
        schedule_kind   TEXT NOT NULL CHECK (schedule_kind IN ('once', 'cron')),
        schedule_expr   TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'active',
        next_fire_at    INTEGER NOT NULL,
        last_fired_at   INTEGER,
        created_at      INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_scheduled_actions_due
        ON scheduled_actions(next_fire_at) WHERE status = 'active';

      -- Carry forward existing reminders/timers as one-shot actions.
      -- Guarded by schema_version so the back-fill only runs once
      -- (runMigrations re-executes every migration's SQL on every open).
      INSERT INTO scheduled_actions (goal, schedule_kind, schedule_expr, status, next_fire_at, last_fired_at, created_at)
      SELECT
        'Напиши мне в Telegram: ' || text,
        'once',
        CAST(fire_at AS TEXT),
        CASE status WHEN 'pending' THEN 'active' WHEN 'fired' THEN 'done' ELSE status END,
        fire_at,
        fired_at,
        created_at
      FROM reminders
      WHERE NOT EXISTS (SELECT 1 FROM schema_version WHERE version = 4);

      INSERT INTO scheduled_actions (goal, schedule_kind, schedule_expr, status, next_fire_at, last_fired_at, created_at)
      SELECT
        'Напиши мне в Telegram: ⏱ Timer "' || label || '" finished.',
        'once',
        CAST(fire_at AS TEXT),
        CASE status WHEN 'active' THEN 'active' WHEN 'fired' THEN 'done' ELSE status END,
        fire_at,
        fired_at,
        created_at
      FROM timers
      WHERE NOT EXISTS (SELECT 1 FROM schema_version WHERE version = 4);

      INSERT OR IGNORE INTO schema_version (version) VALUES (4);
    `,
  },
];
