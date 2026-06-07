import { and, asc, eq, inArray, lte } from 'drizzle-orm';
import type { Db } from './db.ts';
import { scheduledActions } from './schema.ts';
import type { Schedule } from '../scheduling/types.ts';
import type { NewScheduledAction, ScheduledAction, ScheduledActionsAdapter } from './types.ts';

type Row = typeof scheduledActions.$inferSelect;

const toSchedule = (kind: Row['scheduleKind'], expr: string): Schedule =>
  kind === 'once' ? { kind: 'once', at: Number(expr) } : { kind: 'cron', expr };

const toScheduledAction = (r: Row): ScheduledAction => ({
  id: r.id,
  goal: r.goal,
  schedule: toSchedule(r.scheduleKind, r.scheduleExpr),
  status: r.status,
  nextFireAt: r.nextFireAt,
  lastFiredAt: r.lastFiredAt,
  createdAt: r.createdAt,
  ownerUserId: r.ownerUserId,
});

export class SqliteScheduledActions implements ScheduledActionsAdapter {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  add(input: NewScheduledAction): ScheduledAction {
    const now = Date.now();
    const kind = input.schedule.kind;
    const expr = input.schedule.kind === 'once' ? String(input.schedule.at) : input.schedule.expr;
    const row = this.db
      .insert(scheduledActions)
      .values({
        goal: input.goal,
        scheduleKind: kind,
        scheduleExpr: expr,
        status: 'active',
        nextFireAt: input.nextFireAt,
        createdAt: now,
        ownerUserId: input.ownerUserId,
      })
      .returning()
      .get();
    return toScheduledAction(row);
  }

  listActiveForOwner(userId: number): ScheduledAction[] {
    return this.db
      .select()
      .from(scheduledActions)
      .where(and(eq(scheduledActions.status, 'active'), eq(scheduledActions.ownerUserId, userId)))
      .orderBy(asc(scheduledActions.nextFireAt))
      .all()
      .map(toScheduledAction);
  }

  listDue(now: number): ScheduledAction[] {
    return this.db
      .select()
      .from(scheduledActions)
      .where(and(eq(scheduledActions.status, 'active'), lte(scheduledActions.nextFireAt, now)))
      .orderBy(asc(scheduledActions.nextFireAt))
      .all()
      .map(toScheduledAction);
  }

  markFired(id: number, at: number, nextFireAt: number | null): void {
    if (nextFireAt === null) {
      this.db
        .update(scheduledActions)
        .set({ status: 'done', lastFiredAt: at })
        .where(and(eq(scheduledActions.id, id), eq(scheduledActions.status, 'active')))
        .run();
    } else {
      this.db
        .update(scheduledActions)
        .set({ nextFireAt, lastFiredAt: at })
        .where(and(eq(scheduledActions.id, id), eq(scheduledActions.status, 'active')))
        .run();
    }
  }

  markError(id: number): void {
    this.db
      .update(scheduledActions)
      .set({ status: 'error' })
      .where(and(eq(scheduledActions.id, id), inArray(scheduledActions.status, ['active', 'done'])))
      .run();
  }

  cancel(id: number, userId: number): boolean {
    const res = this.db
      .update(scheduledActions)
      .set({ status: 'cancelled' })
      .where(
        and(
          eq(scheduledActions.id, id),
          eq(scheduledActions.ownerUserId, userId),
          eq(scheduledActions.status, 'active'),
        ),
      )
      .run();
    return res.changes > 0;
  }

  get(id: number): ScheduledAction | null {
    const row = this.db.select().from(scheduledActions).where(eq(scheduledActions.id, id)).get();
    return row ? toScheduledAction(row) : null;
  }
}
