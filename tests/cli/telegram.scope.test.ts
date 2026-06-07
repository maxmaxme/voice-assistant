import { describe, it, expect } from 'vitest';
import { IdentitiesStore } from '../../src/memory/identities.ts';
import { resolveTelegramScope } from '../../src/cli/runners/telegram.ts';
import { freshTestDb } from '../memory/helpers.ts';
import type Database from 'better-sqlite3';

function ids(): IdentitiesStore {
  const { db } = freshTestDb();
  return new IdentitiesStore(db);
}

function idsWithDb(): { db: Database.Database; s: IdentitiesStore } {
  const { sqlite, db } = freshTestDb();
  return { db: sqlite, s: new IdentitiesStore(db) };
}

describe('resolveTelegramScope', () => {
  it('returns a scope for an attached chat', () => {
    const s = ids();
    const max = s.addUser('Max');
    s.attachIdentity('telegram', '111', max);
    expect(resolveTelegramScope(s, 111)).toEqual({ userId: max });
  });

  it('returns null for an unknown chat (dropped)', () => {
    const s = ids();
    expect(resolveTelegramScope(s, 999)).toBeNull();
  });

  it('stamps last_used on a successful resolve, not on a miss', () => {
    const { db, s } = idsWithDb();
    const max = s.addUser('Max');
    s.attachIdentity('telegram', '111', max);

    resolveTelegramScope(s, 999); // miss → no row touched
    const before = Date.now();
    resolveTelegramScope(s, 111); // hit → touched
    const used = db
      .prepare<
        [],
        { last_used_at: number | null }
      >(`SELECT last_used_at FROM identities WHERE channel='telegram' AND identity='111'`)
      .get();
    expect(used?.last_used_at).not.toBeNull();
    expect(used!.last_used_at!).toBeGreaterThanOrEqual(before);
  });
});
