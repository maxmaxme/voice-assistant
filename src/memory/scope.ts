import type { ProfileFacts } from './types.ts';
import type { SqliteProfileMemory } from './sqliteProfileMemory.ts';

export const HOUSEHOLD_OWNER = 'household';

export function personalOwner(userId: number): string {
  return `user:${userId}`;
}

export type Role = 'shared' | 'member';
export type WriteScope = 'personal' | 'household';

export interface Scope {
  role: Role;
  /** The resolved principal's user id. For `shared` it is the `home` user;
   *  its value is unused for ownership (shared always maps to household). */
  userId: number;
}

/** A scope-bound view over the profile store. `remember`/`forget` take an
 *  optional write scope; for `shared` principals it is always forced to
 *  household. Reads merge the scope's owner-set (personal overrides
 *  household on key collision). */
export interface ScopedProfile {
  recall(key?: string): ProfileFacts;
  remember(key: string, value: unknown, scope?: WriteScope): void;
  forget(key: string, scope?: WriteScope): void;
}

export function makeScopedProfile(store: SqliteProfileMemory, scope: Scope): ScopedProfile {
  const personal = personalOwner(scope.userId);
  const readOwners = scope.role === 'shared' ? [HOUSEHOLD_OWNER] : [HOUSEHOLD_OWNER, personal];

  const writeOwner = (req?: WriteScope): string => {
    if (scope.role === 'shared') {
      return HOUSEHOLD_OWNER;
    }
    return req === 'household' ? HOUSEHOLD_OWNER : personal;
  };

  return {
    recall: (key) => store.recallFor(readOwners, key),
    remember: (key, value, req) => store.rememberFor(writeOwner(req), key, value),
    forget: (key, req) => store.forgetFor(writeOwner(req), key),
  };
}

/** Convenience for callers with no per-user identity (speaker, /assist
 *  system token, goal runner). Equivalent to a `shared` scope. */
export function householdProfile(store: SqliteProfileMemory): ScopedProfile {
  return makeScopedProfile(store, { role: 'shared', userId: 0 });
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
