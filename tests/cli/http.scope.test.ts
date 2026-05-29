import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/memory/migrate.ts';
import { IdentitiesStore, hashToken } from '../../src/memory/identities.ts';
import { resolveHttpScope } from '../../src/cli/runners/http.ts';

function ids(): IdentitiesStore {
  const db = new Database(':memory:');
  runMigrations(db);
  return new IdentitiesStore(db);
}

describe('resolveHttpScope', () => {
  it('maps a member token to its user scope', () => {
    const s = ids();
    const max = s.addUser('Max', 'member');
    s.attachIdentity('http', hashToken('k1'), max);
    expect(resolveHttpScope(s, 'Bearer k1')).toEqual({ role: 'member', userId: max });
  });

  it('falls back to shared/household for an unknown token', () => {
    const s = ids();
    expect(resolveHttpScope(s, 'Bearer mystery')).toEqual({ role: 'shared', userId: 0 });
  });

  it('falls back to shared for a missing/malformed header', () => {
    const s = ids();
    expect(resolveHttpScope(s, null)).toEqual({ role: 'shared', userId: 0 });
    expect(resolveHttpScope(s, 'Basic xyz')).toEqual({ role: 'shared', userId: 0 });
  });
});
