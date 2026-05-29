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
  it('add-user creates a member user and returns its id', () => {
    const s = ids();
    const out = runUsersCommand(s, ['add-user', '--name', 'Max', '--role', 'member']);
    expect(out.userId).toBeGreaterThan(0);
  });

  it('attach-telegram links a chat to a user', () => {
    const s = ids();
    const { userId } = runUsersCommand(s, ['add-user', '--name', 'Max', '--role', 'member']);
    runUsersCommand(s, ['attach-telegram', '--user', String(userId), '--chat', '555']);
    expect(s.resolve('telegram', '555')).toEqual({ userId, role: 'member' });
  });

  it('mint-http returns a token and stores only its hash', () => {
    const s = ids();
    const { userId } = runUsersCommand(s, ['add-user', '--name', 'Max', '--role', 'member']);
    const out = runUsersCommand(s, ['mint-http', '--user', String(userId)]);
    expect(out.token).toBeTruthy();
    expect(s.resolve('http', hashToken(out.token!))).toEqual({ userId, role: 'member' });
  });

  it('add-user defaults role to member', () => {
    const s = ids();
    const { userId } = runUsersCommand(s, ['add-user', '--name', 'Guest']);
    runUsersCommand(s, ['attach-telegram', '--user', String(userId), '--chat', '7']);
    expect(s.resolve('telegram', '7')?.role).toBe('member');
  });

  it('throws on unknown command', () => {
    const s = ids();
    expect(() => runUsersCommand(s, ['frobnicate'])).toThrow();
  });
});
