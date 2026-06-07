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

  it('attach-voice binds the device token to a user as a voice identity', () => {
    const s = ids();
    const { userId } = runUsersCommand(s, ['add-user', '--name', 'living-room']);
    runUsersCommand(s, ['attach-voice', '--user', String(userId), '--token', 'dev-tok']);
    expect(s.resolve('voice', hashToken('dev-tok'))).toEqual({ userId });
  });

  it('attach-voice requires --user and --token', () => {
    const s = ids();
    const { userId } = runUsersCommand(s, ['add-user', '--name', 'living-room']);
    expect(() => runUsersCommand(s, ['attach-voice', '--user', String(userId)])).toThrow();
    expect(() => runUsersCommand(s, ['attach-voice', '--token', 'x'])).toThrow();
  });

  it('users are non-admin by default', () => {
    const s = ids();
    const { userId } = runUsersCommand(s, ['add-user', '--name', 'Max']);
    expect(s.isAdmin(userId!)).toBe(false);
  });

  it('set-admin promotes a user, and --admin false demotes', () => {
    const s = ids();
    const { userId } = runUsersCommand(s, ['add-user', '--name', 'Max']);
    runUsersCommand(s, ['set-admin', '--user', String(userId)]);
    expect(s.isAdmin(userId!)).toBe(true);
    runUsersCommand(s, ['set-admin', '--user', String(userId), '--admin', 'false']);
    expect(s.isAdmin(userId!)).toBe(false);
  });

  it('set-admin requires --user', () => {
    const s = ids();
    expect(() => runUsersCommand(s, ['set-admin'])).toThrow();
  });

  it('throws on unknown command', () => {
    const s = ids();
    expect(() => runUsersCommand(s, ['frobnicate'])).toThrow();
  });
});
