import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/memory/migrate.ts';
import { IdentitiesStore, hashToken } from '../../src/memory/identities.ts';

function store(): IdentitiesStore {
  const db = new Database(':memory:');
  runMigrations(db);
  return new IdentitiesStore(db);
}

describe('IdentitiesStore', () => {
  it('hashToken is stable and not the raw token', () => {
    expect(hashToken('secret')).toBe(hashToken('secret'));
    expect(hashToken('secret')).not.toBe('secret');
    expect(hashToken('secret')).toHaveLength(64);
  });

  it('resolves an attached identity to its user + role', () => {
    const s = store();
    const home = s.addUser('home', 'shared');
    const max = s.addUser('Max', 'member');
    s.attachIdentity('voice', 'devhash', home);
    s.attachIdentity('telegram', '12345', max);
    expect(s.resolve('voice', 'devhash')).toEqual({ userId: home, role: 'shared' });
    expect(s.resolve('telegram', '12345')).toEqual({ userId: max, role: 'member' });
  });

  it('returns null for unknown identity', () => {
    const s = store();
    expect(s.resolve('telegram', 'nope')).toBeNull();
  });

  it('isEmpty reflects whether any identity exists', () => {
    const s = store();
    expect(s.isEmpty()).toBe(true);
    const u = s.addUser('home', 'shared');
    s.attachIdentity('voice', 'h', u);
    expect(s.isEmpty()).toBe(false);
  });

  it('attaching a duplicate (channel, identity) throws', () => {
    const s = store();
    const u = s.addUser('Max', 'member');
    s.attachIdentity('telegram', '1', u);
    expect(() => s.attachIdentity('telegram', '1', u)).toThrow();
  });
});
