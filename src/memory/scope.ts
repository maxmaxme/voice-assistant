import type { ProfileFacts } from './types.ts';
import type { SqliteProfileMemory } from './sqliteProfileMemory.ts';

export const HOUSEHOLD_OWNER = 'household';

export function personalOwner(userId: number): string {
  return `user:${userId}`;
}

export type WriteScope = 'personal' | 'household';

/** Outcome of a `forget`, so the caller can tell the user what actually
 *  happened rather than always claiming success. */
export interface ForgetResult {
  /** Whether any stored entry was removed. */
  deleted: boolean;
  /** Which layer the entry was removed from. Absent when nothing was deleted. */
  scope?: WriteScope;
  /** True when a personal entry was removed but a household entry with the
   *  same key remains and now surfaces in `recall`. */
  revealed?: boolean;
}

function hasKey(facts: ProfileFacts, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(facts, key);
}

export interface Scope {
  /** The resolved principal's user id. Every principal — person or speaker —
   *  reads `household ∪ personal(userId)` and writes `personal` by default. */
  userId: number;
}

/** A scope-bound view over the profile store. `remember` takes an optional
 *  write scope; writes go to the principal's personal owner by default, or to
 *  household when `scope='household'`. `forget` is personal-first: it removes
 *  the value the principal actually sees (personal overrides household), one
 *  layer at a time, and reports which scope it touched. Reads merge the
 *  scope's owner-set (personal overrides household on key collision). */
export interface ScopedProfile {
  recall(key?: string): ProfileFacts;
  remember(key: string, value: unknown, scope?: WriteScope): void;
  forget(key: string): ForgetResult;
}

export function makeScopedProfile(store: SqliteProfileMemory, scope: Scope): ScopedProfile {
  const personal = personalOwner(scope.userId);
  const readOwners = [HOUSEHOLD_OWNER, personal];

  const writeOwner = (req?: WriteScope): string =>
    req === 'household' ? HOUSEHOLD_OWNER : personal;

  return {
    recall: (key) => store.recallFor(readOwners, key),
    remember: (key, value, req) => store.rememberFor(writeOwner(req), key, value),
    forget: (key) => {
      // Personal-first: delete the layer the principal actually sees. Only
      // touch household when there is no personal copy to remove — so "forget
      // X" can't silently wipe a shared fact the user didn't know was shared.
      if (hasKey(store.recallFor([personal], key), key)) {
        store.forgetFor(personal, key);
        const revealed = hasKey(store.recallFor([HOUSEHOLD_OWNER], key), key);
        return { deleted: true, scope: 'personal', revealed };
      }
      if (hasKey(store.recallFor([HOUSEHOLD_OWNER], key), key)) {
        store.forgetFor(HOUSEHOLD_OWNER, key);
        return { deleted: true, scope: 'household' };
      }
      return { deleted: false };
    },
  };
}

/** Convenience for callers with no per-user identity (goal runner, realtime
 *  fallback). A household-ONLY view: reads and writes `household`, ignoring
 *  any write-scope argument. */
export function householdProfile(store: SqliteProfileMemory): ScopedProfile {
  return {
    recall: (key) => store.recallFor([HOUSEHOLD_OWNER], key),
    remember: (key, value) => store.rememberFor(HOUSEHOLD_OWNER, key, value),
    forget: (key) => {
      const existed = hasKey(store.recallFor([HOUSEHOLD_OWNER], key), key);
      store.forgetFor(HOUSEHOLD_OWNER, key);
      return existed ? { deleted: true, scope: 'household' } : { deleted: false };
    },
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
    forget: (key) => {
      const existed = hasKey(adapter.recall(key), key);
      adapter.forget(key);
      return existed ? { deleted: true, scope: 'household' } : { deleted: false };
    },
  };
}
