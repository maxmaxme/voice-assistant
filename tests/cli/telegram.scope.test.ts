import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/memory/migrate.ts';
import { IdentitiesStore } from '../../src/memory/identities.ts';
import { resolveTelegramScope } from '../../src/cli/runners/telegram.ts';

function ids(): IdentitiesStore {
  const db = new Database(':memory:');
  runMigrations(db);
  return new IdentitiesStore(db);
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
});
