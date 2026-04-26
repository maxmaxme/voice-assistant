import type Database from 'better-sqlite3';
import type { Schedule } from '../scheduling/types.ts';
import type { NewScheduledAction, ScheduledAction, ScheduledActionsAdapter } from './types.ts';

interface Row {
  id: number;
  goal: string;
  schedule_kind: 'once' | 'cron';
  schedule_expr: string;
  status: ScheduledAction['status'];
  next_fire_at: number;
  last_fired_at: number | null;
  created_at: number;
}

const toSchedule = (kind: Row['schedule_kind'], expr: string): Schedule =>
  kind === 'once' ? { kind: 'once', at: Number(expr) } : { kind: 'cron', expr };

const toScheduledAction = (r: Row): ScheduledAction => ({
  id: r.id,
  goal: r.goal,
  schedule: toSchedule(r.schedule_kind, r.schedule_expr),
  status: r.status,
  nextFireAt: r.next_fire_at,
  lastFiredAt: r.last_fired_at,
  createdAt: r.created_at,
});

export class SqliteScheduledActions implements ScheduledActionsAdapter {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  add(input: NewScheduledAction): ScheduledAction {
    const now = Date.now();
    const kind = input.schedule.kind;
    const expr = input.schedule.kind === 'once' ? String(input.schedule.at) : input.schedule.expr;
    const result = this.db
      .prepare(
        `INSERT INTO scheduled_actions
           (goal, schedule_kind, schedule_expr, status, next_fire_at, created_at)
         VALUES (?, ?, ?, 'active', ?, ?)`,
      )
      .run(input.goal, kind, expr, input.nextFireAt, now);
    return this.get(Number(result.lastInsertRowid))!;
  }

  listActive(): ScheduledAction[] {
    const rows = this.db
      .prepare(`SELECT * FROM scheduled_actions WHERE status = 'active' ORDER BY next_fire_at ASC`)
      .all() as Row[];
    return rows.map(toScheduledAction);
  }

  listDue(now: number): ScheduledAction[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM scheduled_actions
         WHERE status = 'active' AND next_fire_at <= ?
         ORDER BY next_fire_at ASC`,
      )
      .all(now) as Row[];
    return rows.map(toScheduledAction);
  }

  markFired(id: number, at: number, nextFireAt: number | null): void {
    if (nextFireAt === null) {
      this.db
        .prepare(
          `UPDATE scheduled_actions
           SET status = 'done', last_fired_at = ?
           WHERE id = ? AND status = 'active'`,
        )
        .run(at, id);
    } else {
      this.db
        .prepare(
          `UPDATE scheduled_actions
           SET next_fire_at = ?, last_fired_at = ?
           WHERE id = ? AND status = 'active'`,
        )
        .run(nextFireAt, at, id);
    }
  }

  markError(id: number): void {
    this.db
      .prepare(`UPDATE scheduled_actions SET status = 'error' WHERE id = ? AND status = 'active'`)
      .run(id);
  }

  cancel(id: number): boolean {
    const res = this.db
      .prepare(
        `UPDATE scheduled_actions SET status = 'cancelled' WHERE id = ? AND status = 'active'`,
      )
      .run(id);
    return res.changes > 0;
  }

  get(id: number): ScheduledAction | null {
    const row = this.db.prepare(`SELECT * FROM scheduled_actions WHERE id = ?`).get(id) as
      | Row
      | undefined;
    return row ? toScheduledAction(row) : null;
  }
}
