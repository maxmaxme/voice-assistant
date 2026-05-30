import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/memory/migrate.ts';
import { SqliteProfileMemory } from '../../src/memory/sqliteProfileMemory.ts';
import { IdentitiesStore, hashToken } from '../../src/memory/identities.ts';
import { HOUSEHOLD_OWNER, personalOwner } from '../../src/memory/scope.ts';
import { speakerProfile } from '../../src/cli/unified.ts';

function setup() {
  const db = new Database(':memory:');
  runMigrations(db);
  return { db, store: new SqliteProfileMemory({ db }), ids: new IdentitiesStore(db) };
}

describe('speakerProfile', () => {
  it('registered device token → reads household ∪ personal(speaker), writes personal by default', () => {
    const { store, ids } = setup();
    const uid = ids.addUser('living-room');
    ids.attachIdentity('voice', hashToken('dev-tok'), uid);
    store.rememberFor(HOUSEHOLD_OWNER, 'tv', 'Samsung');

    const p = speakerProfile(ids, store, 'dev-tok');
    expect(p.recall()).toEqual({ tv: 'Samsung' });
    p.remember('location', 'living room'); // default → personal(speaker)
    expect(store.recallFor([personalOwner(uid)])).toEqual({ location: 'living room' });
    expect(store.recallFor([HOUSEHOLD_OWNER])).toEqual({ tv: 'Samsung' }); // not leaked
    expect(p.recall()).toEqual({ tv: 'Samsung', location: 'living room' });
  });

  it('unregistered device token → household-only', () => {
    const { store, ids } = setup();
    store.rememberFor(HOUSEHOLD_OWNER, 'tv', 'Samsung');
    const p = speakerProfile(ids, store, 'unknown-tok');
    expect(p.recall()).toEqual({ tv: 'Samsung' });
    p.remember('x', 1); // household-only view writes to household
    expect(store.recallFor([HOUSEHOLD_OWNER])).toEqual({ tv: 'Samsung', x: 1 });
  });

  it('stamps last_used on a registered speaker, not on an unknown token', () => {
    const { db, store, ids } = setup();
    const uid = ids.addUser('living-room');
    ids.attachIdentity('voice', hashToken('dev-tok'), uid);

    speakerProfile(ids, store, 'unknown-tok'); // no matching voice identity → no touch
    const before = Date.now();
    speakerProfile(ids, store, 'dev-tok'); // registered → touched
    const used = db
      .prepare<
        [string],
        { last_used_at: number | null }
      >(`SELECT last_used_at FROM identities WHERE channel='voice' AND identity=?`)
      .get(hashToken('dev-tok'));
    expect(used?.last_used_at).not.toBeNull();
    expect(used!.last_used_at!).toBeGreaterThanOrEqual(before);
  });
});
