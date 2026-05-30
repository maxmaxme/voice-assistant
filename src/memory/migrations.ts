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
        'Send me a message in Telegram: ' || text,
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
        'Send me a message in Telegram: ⏱ Timer "' || label || '" finished.',
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
  {
    version: 5,
    sql: `
      CREATE TABLE IF NOT EXISTS telegram_sessions (
        chat_id              INTEGER PRIMARY KEY,
        last_response_id     TEXT,
        pending_ask_call_id  TEXT,
        updated_at           INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO schema_version (version) VALUES (5);
    `,
  },
  {
    version: 6,
    sql: `
      ALTER TABLE telegram_sessions ADD COLUMN pending_tool_outputs TEXT;
      INSERT OR IGNORE INTO schema_version (version) VALUES (6);
    `,
  },
  {
    version: 7,
    sql: `
      -- Rebuild profile with an owner column and (owner, key) PK.
      ALTER TABLE profile RENAME TO profile_old;
      CREATE TABLE profile (
        owner      TEXT NOT NULL DEFAULT 'household',
        key        TEXT NOT NULL,
        value      TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (owner, key)
      );
      INSERT INTO profile (owner, key, value, updated_at)
        SELECT 'household', key, value, updated_at FROM profile_old;
      DROP TABLE profile_old;

      CREATE TABLE IF NOT EXISTS users (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT NOT NULL,
        role       TEXT NOT NULL CHECK (role IN ('shared', 'member')),
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS identities (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        channel    TEXT NOT NULL CHECK (channel IN ('telegram', 'http', 'voice')),
        identity   TEXT NOT NULL,
        user_id    INTEGER NOT NULL REFERENCES users(id),
        created_at INTEGER NOT NULL,
        UNIQUE (channel, identity)
      );

      INSERT OR IGNORE INTO schema_version (version) VALUES (7);
    `,
  },
  {
    version: 8,
    sql: `
      -- Drop the now-unused role column (member/shared). Every principal is
      -- uniform now. SQLite can't DROP a column used in a CHECK, so rebuild.
      -- We build the new table under a temp name and DROP+RENAME into place
      -- (rather than renaming the live users table away): renaming the
      -- *referenced* table rewrites identities.user_id's REFERENCES users(id)
      -- text to point at the temp name, which then dangles after the drop.
      -- Dropping and recreating under the same name keeps that FK reference
      -- intact.
      -- foreign_keys is off, so the FK is unenforced regardless; ids are
      -- preserved by the explicit copy.
      CREATE TABLE users_new (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      INSERT INTO users_new (id, name, created_at)
        SELECT id, name, created_at FROM users;
      DROP TABLE users;
      ALTER TABLE users_new RENAME TO users;

      INSERT OR IGNORE INTO schema_version (version) VALUES (8);
    `,
  },
  {
    version: 9,
    sql: `
      -- Drop dead tables. 'kv' (v2) was never read/written by any code.
      -- 'reminders'/'timers' (v3) were superseded by 'scheduled_actions':
      -- v4 already carried their rows forward, and nothing reads them since.
      -- Dropping a table also drops its indexes (idx_reminders_due,
      -- idx_timers_due). IF EXISTS so a hand-cleaned DB still migrates.
      DROP TABLE IF EXISTS kv;
      DROP TABLE IF EXISTS reminders;
      DROP TABLE IF EXISTS timers;
      INSERT OR IGNORE INTO schema_version (version) VALUES (9);
    `,
  },
  {
    version: 10,
    sql: `
      -- Give every scheduled action an author so reminders fire back to the
      -- person who set them (resolved to their Telegram at fire time) instead
      -- of a hard-coded chat id. NOT NULL DEFAULT 1 backfills the single
      -- existing row to user 1 (the only user today) and forbids nulls going
      -- forward; new rows always supply owner_user_id explicitly, so the
      -- DEFAULT only ever applies to a raw insert that omits the column.
      ALTER TABLE scheduled_actions ADD COLUMN owner_user_id INTEGER NOT NULL DEFAULT 1;
      INSERT OR IGNORE INTO schema_version (version) VALUES (10);
    `,
  },
  {
    version: 11,
    sql: `
      -- Record when each identity last successfully authorized. Nullable, no
      -- backfill: NULL means "not used since this column shipped" — created_at
      -- already records provenance, and faking a past last-used would lie.
      ALTER TABLE identities ADD COLUMN last_used_at INTEGER;
      INSERT OR IGNORE INTO schema_version (version) VALUES (11);
    `,
  },
];
