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
  it('maps a token to its user scope', () => {
    const s = ids();
    const max = s.addUser('Max');
    s.attachIdentity('http', hashToken('k1'), max);
    expect(resolveHttpScope(s, 'Bearer k1')).toEqual({ userId: max });
  });

  it('falls back to userId 0 (household) for an unknown token', () => {
    const s = ids();
    expect(resolveHttpScope(s, 'Bearer mystery')).toEqual({ userId: 0 });
  });

  it('falls back to userId 0 for a missing/malformed header', () => {
    const s = ids();
    expect(resolveHttpScope(s, null)).toEqual({ userId: 0 });
    expect(resolveHttpScope(s, 'Basic xyz')).toEqual({ userId: 0 });
  });
});
