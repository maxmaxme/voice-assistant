import type { RemindersAdapter, TimersAdapter } from '../memory/types.ts';
import type { DueItem, FireSink } from './types.ts';

export interface SchedulerOptions {
  reminders: RemindersAdapter;
  timers: TimersAdapter;
  sink: FireSink;
  /** Tick interval in ms. Default 15000. */
  tickMs?: number;
}

export class Scheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private readonly reminders: RemindersAdapter;
  private readonly timers: TimersAdapter;
  private readonly sink: FireSink;
  private readonly tickMs: number;

  constructor(opts: SchedulerOptions) {
    this.reminders = opts.reminders;
    this.timers = opts.timers;
    this.sink = opts.sink;
    this.tickMs = opts.tickMs ?? 15_000;
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
    if (!this.running) {
      return;
    }
    const now = Date.now();
    let dueReminders: ReturnType<RemindersAdapter['listDue']>;
    let dueTimers: ReturnType<TimersAdapter['listDue']>;
    try {
      dueReminders = this.reminders.listDue(now);
      dueTimers = this.timers.listDue(now);
    } catch (err) {
      process.stderr.write(`[scheduler] listDue failed: ${(err as Error).message}\n`);
      return;
    }

    for (const r of dueReminders) {
      const item: DueItem = { kind: 'reminder', id: r.id, text: r.text, fireAt: r.fireAt };
      try {
        await this.sink.fire(item);
        this.reminders.markFired(r.id, Date.now());
      } catch (err) {
        process.stderr.write(
          `[scheduler] reminder ${r.id} fire failed: ${(err as Error).message}\n`,
        );
      }
    }
    for (const t of dueTimers) {
      const item: DueItem = {
        kind: 'timer',
        id: t.id,
        label: t.label,
        fireAt: t.fireAt,
        durationMs: t.durationMs,
      };
      try {
        await this.sink.fire(item);
        this.timers.markFired(t.id, Date.now());
      } catch (err) {
        process.stderr.write(`[scheduler] timer ${t.id} fire failed: ${(err as Error).message}\n`);
      }
    }
  }
}
