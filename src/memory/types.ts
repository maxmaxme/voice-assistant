import type { Schedule } from '../scheduling/types.ts';
import type { SqliteProfileMemory } from './sqliteProfileMemory.ts';

export type ProfileFacts = Record<string, unknown>;

export type Channel = 'telegram' | 'http' | 'voice';

export interface IdentityResolution {
  userId: number;
}

export interface IdentitiesAdapter {
  resolve(channel: Channel, identity: string): IdentityResolution | null;
  /** Stamp `last_used_at = now` on a `(channel, identity)` row after a
   *  successful authorization. A miss updates nothing (no-op). Kept separate
   *  from `resolve` so that read stays pure — see migration v11. */
  touch(channel: Channel, identity: string): void;
  /** Reverse of `resolve`: the identity string for a user on a channel (e.g.
   *  their Telegram chat id), or null if none. Returns the earliest-attached
   *  one when a user has several. */
  identityFor(channel: Channel, userId: number): string | null;
  /** All users that have a Telegram identity, for recipient resolution and
   *  for listing valid recipients in errors. */
  listTelegramUsers(): { userId: number; name: string; chatId: string }[];
  addUser(name: string): number;
  attachIdentity(channel: Channel, identity: string, userId: number): void;
  /** Whether a user is allowed to run privileged commands (e.g. /update).
   *  Unknown user → false. */
  isAdmin(userId: number): boolean;
  /** Promote/demote a user as admin. Missing user → no-op. */
  setAdmin(userId: number, isAdmin: boolean): void;
  isEmpty(): boolean;
}

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
  /** The user who created this action. Reminders fire back to this user's
   *  Telegram. Non-nullable since migration v10 (legacy rows backfilled). */
  ownerUserId: number;
}

export interface NewScheduledAction {
  goal: string;
  schedule: Schedule;
  nextFireAt: number;
  ownerUserId: number;
}

export interface ScheduledActionsAdapter {
  add(input: NewScheduledAction): ScheduledAction;
  /** Active actions owned by `userId` (for per-user list/cancel). */
  listActiveForOwner(userId: number): ScheduledAction[];
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
  /** Cancel an active action, but only if it is owned by `userId`. Returns
   *  true iff a row was cancelled. */
  cancel(id: number, userId: number): boolean;
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
  /** The raw owner-aware profile store, for scope-aware callers. */
  profileStore: SqliteProfileMemory;
  identities: IdentitiesAdapter;
  scheduledActions: ScheduledActionsAdapter;
  telegramSessions: TelegramSessionsAdapter;
  close(): void;
}
