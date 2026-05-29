import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/memory/migrate.ts';
import { IdentitiesStore, hashToken } from '../../src/memory/identities.ts';
import { seedIdentitiesFromConfig } from '../../src/memory/seed.ts';

function store(): IdentitiesStore {
  const db = new Database(':memory:');
  runMigrations(db);
  return new IdentitiesStore(db);
}

describe('seedIdentitiesFromConfig', () => {
  it('creates home (shared) for voice + ha token, and a member per chat/key', () => {
    const s = store();
    seedIdentitiesFromConfig(s, {
      allowedChatIds: [111, 222],
      httpApiKeys: ['k1', 'k2'],
      voiceToken: 'devtoken',
      haToken: 'hatoken',
    });
    const viaVoice = s.resolve('voice', hashToken('devtoken'));
    const viaHa = s.resolve('http', hashToken('hatoken'));
    expect(viaVoice?.role).toBe('shared');
    expect(viaHa?.role).toBe('shared');
    expect(viaVoice?.userId).toBe(viaHa?.userId);

    expect(s.resolve('telegram', '111')?.role).toBe('member');
    expect(s.resolve('telegram', '222')?.role).toBe('member');
    expect(s.resolve('http', hashToken('k1'))?.role).toBe('member');
    expect(s.resolve('telegram', '111')?.userId).not.toBe(s.resolve('telegram', '222')?.userId);
  });

  it('is a no-op when identities already exist', () => {
    const s = store();
    const u = s.addUser('Max', 'member');
    s.attachIdentity('telegram', '111', u);
    seedIdentitiesFromConfig(s, {
      allowedChatIds: [999],
      httpApiKeys: [],
      voiceToken: '',
      haToken: '',
    });
    expect(s.resolve('telegram', '999')).toBeNull();
  });
});
