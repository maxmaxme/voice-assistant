import type { Schedule } from '../scheduling/types.ts';

export type ProfileFacts = Record<string, unknown>;

export interface MemoryAdapter {
  remember(key: string, value: unknown): void;
  recall(key?: string): ProfileFacts;
  forget(key: string): void;
  close(): void;
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

/** A function_call_output we executed locally but haven't yet sent to the
 *  model — used when the model emits `ask` in parallel with other tools.
 *  The ask is terminal (we return to the user), but the other calls still
 *  need their outputs delivered on the next turn or OpenAI will 400 with
 *  "No tool output found for function call <id>". */
export interface PendingToolOutput {
  callId: string;
  output: string;
}

export interface TelegramSessionRecord {
  lastResponseId?: string;
  pendingAskCallId?: string;
  pendingToolOutputs?: PendingToolOutput[];
}

export interface TelegramSessionsAdapter {
  get(chatId: number): TelegramSessionRecord | null;
  save(chatId: number, record: TelegramSessionRecord): void;
  delete(chatId: number): void;
}

export interface MemoryStore {
  profile: MemoryAdapter;
  scheduledActions: ScheduledActionsAdapter;
  telegramSessions: TelegramSessionsAdapter;
  close(): void;
}
