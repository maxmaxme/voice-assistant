import type { ProfileFacts } from './types.ts';
import type { SqliteProfileMemory } from './sqliteProfileMemory.ts';

export const HOUSEHOLD_OWNER = 'household';

export function personalOwner(userId: number): string {
  return `user:${userId}`;
}

export type WriteScope = 'personal' | 'household';

export interface Scope {
  /** The resolved principal's user id. Every principal — person or speaker —
   *  reads `household ∪ personal(userId)` and writes `personal` by default. */
  userId: number;
}

/** A scope-bound view over the profile store. `remember`/`forget` take an
 *  optional write scope; writes go to the principal's personal owner by
 *  default, or to household when `scope='household'`. Reads merge the
 *  scope's owner-set (personal overrides household on key collision). */
export interface ScopedProfile {
  recall(key?: string): ProfileFacts;
  remember(key: string, value: unknown, scope?: WriteScope): void;
  forget(key: string, scope?: WriteScope): void;
}

export function makeScopedProfile(store: SqliteProfileMemory, scope: Scope): ScopedProfile {
  const personal = personalOwner(scope.userId);
  const readOwners = [HOUSEHOLD_OWNER, personal];

  const writeOwner = (req?: WriteScope): string =>
    req === 'household' ? HOUSEHOLD_OWNER : personal;

  return {
    recall: (key) => store.recallFor(readOwners, key),
    remember: (key, value, req) => store.rememberFor(writeOwner(req), key, value),
    forget: (key, req) => store.forgetFor(writeOwner(req), key),
  };
}

/** Convenience for callers with no per-user identity (goal runner, realtime
 *  fallback). A household-ONLY view: reads and writes `household`, ignoring
 *  any write-scope argument. */
export function householdProfile(store: SqliteProfileMemory): ScopedProfile {
  return {
    recall: (key) => store.recallFor([HOUSEHOLD_OWNER], key),
    remember: (key, value) => store.rememberFor(HOUSEHOLD_OWNER, key, value),
    forget: (key) => store.forgetFor(HOUSEHOLD_OWNER, key),
  };
}

/** Wrap a plain household-backed MemoryAdapter (recall/remember/forget with
 *  no scope arg) as a ScopedProfile. Used as the agent's fallback when no
 *  per-request scope is supplied — writes/reads go to the adapter as-is
 *  (household). */
export interface MemoryAdapterLike {
  recall(key?: string): ProfileFacts;
  remember(key: string, value: unknown): void;
  forget(key: string): void;
}

export function householdFromAdapter(adapter: MemoryAdapterLike): ScopedProfile {
  return {
    recall: (key) => adapter.recall(key),
    remember: (key, value) => adapter.remember(key, value),
    forget: (key) => adapter.forget(key),
  };
}
