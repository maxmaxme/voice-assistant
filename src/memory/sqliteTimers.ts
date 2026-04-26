import type Database from 'better-sqlite3';
import type { NewTimer, Timer, TimersAdapter } from './types.ts';

interface Row {
  id: number;
  label: string;
  fire_at: number;
  duration_ms: number;
  status: Timer['status'];
  created_at: number;
  fired_at: number | null;
}

const toTimer = (r: Row): Timer => ({
  id: r.id,
  label: r.label,
  fireAt: r.fire_at,
  durationMs: r.duration_ms,
  status: r.status,
  createdAt: r.created_at,
  firedAt: r.fired_at,
});

export class SqliteTimers implements TimersAdapter {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  add(input: NewTimer): Timer {
    const now = Date.now();
    const result = this.db
      .prepare(
        `INSERT INTO timers (label, fire_at, duration_ms, status, created_at)
         VALUES (?, ?, ?, 'active', ?)`,
      )
      .run(input.label, input.fireAt, input.durationMs, now);
    return this.get(Number(result.lastInsertRowid))!;
  }

  listActive(): Timer[] {
    const rows = this.db
      .prepare(`SELECT * FROM timers WHERE status = 'active' ORDER BY fire_at ASC`)
      .all() as Row[];
    return rows.map(toTimer);
  }

  listDue(now: number): Timer[] {
    const rows = this.db
      .prepare(`SELECT * FROM timers WHERE status = 'active' AND fire_at <= ? ORDER BY fire_at ASC`)
      .all(now) as Row[];
    return rows.map(toTimer);
  }

  markFired(id: number, firedAt: number): void {
    this.db
      .prepare(
        `UPDATE timers SET status = 'fired', fired_at = ?
         WHERE id = ? AND status = 'active'`,
      )
      .run(firedAt, id);
  }

  cancel(id: number): boolean {
    const res = this.db
      .prepare(`UPDATE timers SET status = 'cancelled' WHERE id = ? AND status = 'active'`)
      .run(id);
    return res.changes > 0;
  }

  get(id: number): Timer | null {
    const row = this.db.prepare(`SELECT * FROM timers WHERE id = ?`).get(id) as Row | undefined;
    return row ? toTimer(row) : null;
  }
}
