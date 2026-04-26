import type { ScheduledActionsAdapter, ScheduledAction } from '../memory/types.ts';
import type { GoalRunner } from './goalRunner.ts';
import { nextFireAt as computeNextFireAt } from './cron.ts';
import { createLogger } from '../utils/logger.ts';
import { assertError } from '../utils/assertError.ts';

const log = createLogger('scheduler');

export interface SchedulerOptions {
  scheduledActions: ScheduledActionsAdapter;
  goalRunner: GoalRunner;
  /** Tick interval in ms. Default 15000. */
  tickMs?: number;
  /** Override Date.now (for tests). */
  now?: () => number;
}

export class Scheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private ticking = false;
  private readonly scheduledActions: ScheduledActionsAdapter;
  private readonly goalRunner: GoalRunner;
  private readonly tickMs: number;
  private readonly now: () => number;

  constructor(opts: SchedulerOptions) {
    this.scheduledActions = opts.scheduledActions;
    this.goalRunner = opts.goalRunner;
    this.tickMs = opts.tickMs ?? 15_000;
    this.now = opts.now ?? Date.now;
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.timer = setInterval(() => void this.tick(), this.tickMs);
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(): Promise<void> {
    if (!this.running || this.ticking) {
      return;
    }
    this.ticking = true;
    try {
      await this.runTick();
    } finally {
      this.ticking = false;
    }
  }

  private async runTick(): Promise<void> {
    const now = this.now();
    let due: ScheduledAction[];
    try {
      due = this.scheduledActions.listDue(now);
    } catch (err) {
      assertError(err);
      log.error({ err }, `listDue failed: ${err.message}`);
      return;
    }

    for (const row of due) {
      // Advance the schedule BEFORE firing so a crash mid-fire (process kill,
      // uncaught throw, infinite loop) doesn't tight-loop on the same goal.
      // Trade-off: a once-row may show as "done" before the goal actually finished;
      // if the goal then throws we override to "error". Acceptable.
      let advanced = false;
      try {
        if (row.schedule.kind === 'once') {
          this.scheduledActions.markFired(row.id, now, null);
        } else {
          const next = computeNextFireAt(row.schedule, now);
          this.scheduledActions.markFired(row.id, now, next);
        }
        advanced = true;
      } catch (err) {
        assertError(err);
        // Defense in depth: validateSchedule (Task 3) should have caught any
        // bad cron expression before storage, but if computeNextFireAt throws
        // here we can't safely re-fire the row — terminate it.
        log.error({ actionId: row.id, err }, `action ${row.id} advance failed: ${err.message}`);
        try {
          this.scheduledActions.markError(row.id);
        } catch (markErr) {
          assertError(markErr);
          log.error(
            { actionId: row.id, err: markErr },
            `action ${row.id} markError failed: ${markErr.message}`,
          );
        }
      }

      if (!advanced) {
        continue;
      }

      try {
        await this.goalRunner.fire(row.goal);
      } catch (err) {
        assertError(err);
        log.error({ actionId: row.id, err }, `action ${row.id} fire failed: ${err.message}`);
        if (row.schedule.kind === 'once') {
          // Override the `done` we set in step 1: the action visibly failed.
          try {
            this.scheduledActions.markError(row.id);
          } catch (markErr) {
            assertError(markErr);
            log.error(
              { actionId: row.id, err: markErr },
              `action ${row.id} markError failed: ${markErr.message}`,
            );
          }
        }
        // For cron: status stays `active`, nextFireAt already advanced — retry next firing.
      }
    }
  }
}
