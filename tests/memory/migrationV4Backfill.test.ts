import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { MIGRATIONS } from '../../src/memory/migrations.ts';
import { runMigrations } from '../../src/memory/migrate.ts';

const sortedMigrations = () => [...MIGRATIONS].sort((a, b) => a.version - b.version);

describe('migration v4 back-fill', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });
  afterEach(() => db.close());

  it('carries existing reminders and timers into scheduled_actions', () => {
    // Run v1..v3 only.
    for (const m of sortedMigrations()) {
      if (m.version <= 3) {
        db.exec(m.sql);
      }
    }

    // Insert two reminders and one timer.
    db.prepare(
      `INSERT INTO reminders (text, fire_at, status, created_at, fired_at)
       VALUES (?, ?, 'pending', ?, NULL)`,
    ).run('call mom', 1000, 500);
    db.prepare(
      `INSERT INTO reminders (text, fire_at, status, created_at, fired_at)
       VALUES (?, ?, 'fired', ?, ?)`,
    ).run('water plants', 800, 400, 850);
    db.prepare(
      `INSERT INTO timers (label, fire_at, duration_ms, status, created_at, fired_at)
       VALUES (?, ?, ?, 'active', ?, NULL)`,
    ).run('pasta', 2000, 600000, 600);

    // Now run v4 (and everything else).
    runMigrations(db);

    const rows = db
      .prepare(
        `SELECT goal, schedule_kind, schedule_expr, status, next_fire_at, last_fired_at
         FROM scheduled_actions ORDER BY id ASC`,
      )
      .all() as Array<{
      goal: string;
      schedule_kind: string;
      schedule_expr: string;
      status: string;
      next_fire_at: number;
      last_fired_at: number | null;
    }>;

    expect(rows).toHaveLength(3);

    // Reminder 1: pending -> active
    expect(rows[0].goal).toBe('Напиши мне в Telegram: call mom');
    expect(rows[0].schedule_kind).toBe('once');
    expect(rows[0].schedule_expr).toBe('1000');
    expect(rows[0].status).toBe('active');
    expect(rows[0].next_fire_at).toBe(1000);
    expect(rows[0].last_fired_at).toBeNull();

    // Reminder 2: fired -> done
    expect(rows[1].goal).toBe('Напиши мне в Telegram: water plants');
    expect(rows[1].status).toBe('done');
    expect(rows[1].last_fired_at).toBe(850);

    // Timer: active -> active
    expect(rows[2].goal).toBe('Напиши мне в Telegram: ⏱ Timer "pasta" finished.');
    expect(rows[2].schedule_kind).toBe('once');
    expect(rows[2].schedule_expr).toBe('2000');
    expect(rows[2].status).toBe('active');
    expect(rows[2].next_fire_at).toBe(2000);
  });

  it('back-fill is idempotent across repeated runMigrations calls', () => {
    for (const m of sortedMigrations()) {
      if (m.version <= 3) {
        db.exec(m.sql);
      }
    }
    db.prepare(
      `INSERT INTO reminders (text, fire_at, status, created_at, fired_at)
       VALUES (?, ?, 'pending', ?, NULL)`,
    ).run('call mom', 1000, 500);

    runMigrations(db);
    runMigrations(db);
    runMigrations(db);

    const { c } = db.prepare(`SELECT COUNT(*) AS c FROM scheduled_actions`).get() as {
      c: number;
    };
    expect(c).toBe(1);
  });

  it('records version 4', () => {
    runMigrations(db);
    const max = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as {
      v: number;
    };
    expect(max.v).toBeGreaterThanOrEqual(4);
  });

  it('does NOT drop reminders or timers tables', () => {
    runMigrations(db);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
      name: string;
    }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain('reminders');
    expect(names).toContain('timers');
    expect(names).toContain('scheduled_actions');
  });
});
