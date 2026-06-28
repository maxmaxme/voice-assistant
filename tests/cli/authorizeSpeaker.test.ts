import { describe, it, expect } from 'vitest';
import { IdentitiesStore, hashToken } from '../../src/memory/identities.ts';
import { authorizeSpeaker } from '../../src/cli/unified.ts';
import { freshTestDb } from '../memory/helpers.ts';

function setup() {
  const { sqlite, db } = freshTestDb();
  return { db: sqlite, ids: new IdentitiesStore(db) };
}

describe('authorizeSpeaker', () => {
  it('resolves a registered device token to its owning principal', () => {
    const { ids } = setup();
    const uid = ids.addUser('living-room');
    ids.attachIdentity('voice', hashToken('dev-tok'), uid);

    expect(authorizeSpeaker(ids, 'dev-tok')).toEqual({ userId: uid });
  });

  it('returns null for an unregistered token', () => {
    const { ids } = setup();
    expect(authorizeSpeaker(ids, 'unknown-tok')).toBeNull();
  });

  it('stamps last_used on a registered device, not on an unknown token', () => {
    const { db, ids } = setup();
    const uid = ids.addUser('living-room');
    ids.attachIdentity('voice', hashToken('dev-tok'), uid);

    authorizeSpeaker(ids, 'unknown-tok'); // no match → no touch
    const before = Date.now();
    authorizeSpeaker(ids, 'dev-tok'); // registered → touched
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
