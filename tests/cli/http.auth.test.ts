import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/memory/migrate.ts';
import { IdentitiesStore, hashToken } from '../../src/memory/identities.ts';
import { httpTokenAllowed } from '../../src/cli/runners/http.ts';

function ids(): IdentitiesStore {
  const db = new Database(':memory:');
  runMigrations(db);
  return new IdentitiesStore(db);
}

describe('httpTokenAllowed (DB-backed HTTP auth)', () => {
  it('allows a token whose hash has an http identity', () => {
    const s = ids();
    const u = s.addUser('Max');
    s.attachIdentity('http', hashToken('k1'), u);
    expect(httpTokenAllowed(s, 'Bearer k1')).toBe(true);
  });
  it('rejects an unknown token', () => {
    const s = ids();
    expect(httpTokenAllowed(s, 'Bearer nope')).toBe(false);
  });
  it('rejects a missing or malformed header', () => {
    const s = ids();
    expect(httpTokenAllowed(s, null)).toBe(false);
    expect(httpTokenAllowed(s, 'Basic xyz')).toBe(false);
  });
});
