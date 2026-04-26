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
