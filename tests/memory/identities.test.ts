import { describe, it, expect } from 'vitest';
import type Database from 'better-sqlite3';
import { freshTestDb } from './helpers.ts';
import { IdentitiesStore, hashToken } from '../../src/memory/identities.ts';

function store(): IdentitiesStore {
  return new IdentitiesStore(freshTestDb().db);
}

function withDb(): { sqlite: Database.Database; s: IdentitiesStore } {
  const { sqlite, db } = freshTestDb();
  return { sqlite, s: new IdentitiesStore(db) };
}

function lastUsed(sqlite: Database.Database, channel: string, identity: string): number | null {
  const row = sqlite
    .prepare<
      [string, string],
      { last_used_at: number | null }
    >(`SELECT last_used_at FROM identities WHERE channel = ? AND identity = ?`)
    .get(channel, identity);
  return row ? row.last_used_at : null;
}

describe('IdentitiesStore', () => {
  it('hashToken is stable and not the raw token', () => {
    expect(hashToken('secret')).toBe(hashToken('secret'));
    expect(hashToken('secret')).not.toBe('secret');
    expect(hashToken('secret')).toHaveLength(64);
  });

  it('resolves an attached identity to its user', () => {
    const s = store();
    const home = s.addUser('home');
    const max = s.addUser('Max');
    s.attachIdentity('voice', 'devhash', home);
    s.attachIdentity('telegram', '12345', max);
    expect(s.resolve('voice', 'devhash')).toEqual({ userId: home });
    expect(s.resolve('telegram', '12345')).toEqual({ userId: max });
  });

  it('returns null for unknown identity', () => {
    const s = store();
    expect(s.resolve('telegram', 'nope')).toBeNull();
  });

  it('isEmpty reflects whether any identity exists', () => {
    const s = store();
    expect(s.isEmpty()).toBe(true);
    const u = s.addUser('home');
    s.attachIdentity('voice', 'h', u);
    expect(s.isEmpty()).toBe(false);
  });

  it('attaching a duplicate (channel, identity) throws', () => {
    const s = store();
    const u = s.addUser('Max');
    s.attachIdentity('telegram', '1', u);
    expect(() => s.attachIdentity('telegram', '1', u)).toThrow();
  });

  it('last_used_at starts NULL and resolve does not write it', () => {
    const { sqlite, s } = withDb();
    const u = s.addUser('Max');
    s.attachIdentity('telegram', '1', u);
    expect(lastUsed(sqlite, 'telegram', '1')).toBeNull();
    s.resolve('telegram', '1');
    expect(lastUsed(sqlite, 'telegram', '1')).toBeNull();
  });

  it('touch stamps last_used_at and a later touch advances it', () => {
    const { sqlite, s } = withDb();
    const u = s.addUser('Max');
    s.attachIdentity('telegram', '1', u);

    const before = Date.now();
    s.touch('telegram', '1');
    const first = lastUsed(sqlite, 'telegram', '1');
    expect(first).not.toBeNull();
    expect(first!).toBeGreaterThanOrEqual(before);

    // Force a strictly-later timestamp so the advance is observable even on a
    // fast clock, then confirm touch moves it forward (>=, never backwards).
    sqlite
      .prepare(`UPDATE identities SET last_used_at = 1 WHERE channel='telegram' AND identity='1'`)
      .run();
    s.touch('telegram', '1');
    expect(lastUsed(sqlite, 'telegram', '1')!).toBeGreaterThan(1);
  });

  it('touch on an unknown identity is a silent no-op', () => {
    const { sqlite, s } = withDb();
    expect(() => s.touch('telegram', 'nope')).not.toThrow();
    expect(lastUsed(sqlite, 'telegram', 'nope')).toBeNull();
  });
});
