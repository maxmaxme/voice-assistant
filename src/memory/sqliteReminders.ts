import type Database from 'better-sqlite3';
import type { NewReminder, Reminder, RemindersAdapter } from './types.ts';

interface Row {
  id: number;
  text: string;
  fire_at: number;
  status: Reminder['status'];
  created_at: number;
  fired_at: number | null;
}

const toReminder = (r: Row): Reminder => ({
  id: r.id,
  text: r.text,
  fireAt: r.fire_at,
  status: r.status,
  createdAt: r.created_at,
  firedAt: r.fired_at,
});

export class SqliteReminders implements RemindersAdapter {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  add(input: NewReminder): Reminder {
    const now = Date.now();
    const result = this.db
      .prepare(
        `INSERT INTO reminders (text, fire_at, status, created_at)
         VALUES (?, ?, 'pending', ?)`,
      )
      .run(input.text, input.fireAt, now);
    return this.get(Number(result.lastInsertRowid))!;
  }

  listPending(): Reminder[] {
    const rows = this.db
      .prepare(`SELECT * FROM reminders WHERE status = 'pending' ORDER BY fire_at ASC`)
      .all() as Row[];
    return rows.map(toReminder);
  }

  listDue(now: number): Reminder[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM reminders
         WHERE status = 'pending' AND fire_at <= ?
         ORDER BY fire_at ASC`,
      )
      .all(now) as Row[];
    return rows.map(toReminder);
  }

  markFired(id: number, firedAt: number): void {
    this.db
      .prepare(
        `UPDATE reminders SET status = 'fired', fired_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(firedAt, id);
  }

  cancel(id: number): boolean {
    const res = this.db
      .prepare(`UPDATE reminders SET status = 'cancelled' WHERE id = ? AND status = 'pending'`)
      .run(id);
    return res.changes > 0;
  }

  get(id: number): Reminder | null {
    const row = this.db.prepare(`SELECT * FROM reminders WHERE id = ?`).get(id) as Row | undefined;
    return row ? toReminder(row) : null;
  }
}
