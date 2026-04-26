import type { Schedule } from '../scheduling/types.ts';

export type ProfileFacts = Record<string, unknown>;

export interface MemoryAdapter {
  remember(key: string, value: unknown): void;
  recall(key?: string): ProfileFacts;
  forget(key: string): void;
  close(): void;
}

export interface Reminder {
  id: number;
  text: string;
  fireAt: number;
  status: 'pending' | 'fired' | 'cancelled';
  createdAt: number;
  firedAt: number | null;
}

export interface NewReminder {
  text: string;
  fireAt: number;
}

export interface RemindersAdapter {
  add(input: NewReminder): Reminder;
  listPending(): Reminder[];
  listDue(now: number): Reminder[];
  markFired(id: number, firedAt: number): void;
  cancel(id: number): boolean;
  get(id: number): Reminder | null;
}

export interface Timer {
  id: number;
  label: string;
  fireAt: number;
  durationMs: number;
  status: 'active' | 'fired' | 'cancelled';
  createdAt: number;
  firedAt: number | null;
}

export interface NewTimer {
  label: string;
  fireAt: number;
  durationMs: number;
}

export interface TimersAdapter {
  add(input: NewTimer): Timer;
  listActive(): Timer[];
  listDue(now: number): Timer[];
  markFired(id: number, firedAt: number): void;
  cancel(id: number): boolean;
  get(id: number): Timer | null;
}

export interface ScheduledAction {
  id: number;
  goal: string;
  schedule: Schedule;
  status: 'active' | 'done' | 'cancelled' | 'error';
  nextFireAt: number;
  lastFiredAt: number | null;
  createdAt: number;
}

export interface NewScheduledAction {
  goal: string;
  schedule: Schedule;
  nextFireAt: number;
}

export interface ScheduledActionsAdapter {
  add(input: NewScheduledAction): ScheduledAction;
  listActive(): ScheduledAction[];
  listDue(now: number): ScheduledAction[];
  /** When `nextFireAt` is null, mark `status='done'` (one-shot complete).
   *  When non-null, update `next_fire_at` (cron rescheduling) and set `last_fired_at = at`. */
  markFired(id: number, at: number, nextFireAt: number | null): void;
  /** Mark a row as `status='error'` (terminal failure). Acts on rows in
   *  `'active'` or `'done'` status — used both during initial fire failure
   *  and to override the brief `'done'` window the scheduler creates by
   *  advancing once-rows BEFORE firing. Cancelled and already-error rows
   *  are left alone. */
  markError(id: number): void;
  cancel(id: number): boolean;
  get(id: number): ScheduledAction | null;
}

export interface MemoryStore {
  profile: MemoryAdapter;
  reminders: RemindersAdapter;
  timers: TimersAdapter;
  scheduledActions: ScheduledActionsAdapter;
  close(): void;
}
