import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/memory/migrate.ts';
import { IdentitiesStore, hashToken } from '../../src/memory/identities.ts';
import { runUsersCommand } from '../../src/cli/users.ts';

function ids(): IdentitiesStore {
  const db = new Database(':memory:');
  runMigrations(db);
  return new IdentitiesStore(db);
}

describe('runUsersCommand', () => {
  it('add-user creates a user and returns its id', () => {
    const s = ids();
    const out = runUsersCommand(s, ['add-user', '--name', 'Max']);
    expect(out.userId).toBeGreaterThan(0);
  });

  it('attach-telegram links a chat to a user', () => {
    const s = ids();
    const { userId } = runUsersCommand(s, ['add-user', '--name', 'Max']);
    runUsersCommand(s, ['attach-telegram', '--user', String(userId), '--chat', '555']);
    expect(s.resolve('telegram', '555')).toEqual({ userId });
  });

  it('mint-http returns a token and stores only its hash', () => {
    const s = ids();
    const { userId } = runUsersCommand(s, ['add-user', '--name', 'Max']);
    const out = runUsersCommand(s, ['mint-http', '--user', String(userId)]);
    expect(out.token).toBeTruthy();
    expect(s.resolve('http', hashToken(out.token!))).toEqual({ userId });
  });

  it('throws on unknown command', () => {
    const s = ids();
    expect(() => runUsersCommand(s, ['frobnicate'])).toThrow();
  });
});
