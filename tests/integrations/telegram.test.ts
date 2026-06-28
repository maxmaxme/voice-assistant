import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { freshTestDb, type TestDb } from '../memory/helpers.ts';
import { SqliteIntegrations } from '../../src/integrations/sqliteIntegrations.ts';
import {
  resolveTelegramConfig,
  TELEGRAM_INTEGRATION_TYPE,
} from '../../src/integrations/telegram.ts';
import { integrations } from '../../src/memory/schema.ts';

function install(h: TestDb, config: Record<string, string>, enabled = 1): void {
  h.db
    .insert(integrations)
    .values({
      type: TELEGRAM_INTEGRATION_TYPE,
      config: JSON.stringify(config),
      enabled,
      updatedAt: Date.now(),
    })
    .run();
}

describe('resolveTelegramConfig', () => {
  let h: TestDb;
  let store: SqliteIntegrations;
  beforeEach(() => {
    h = freshTestDb();
    store = new SqliteIntegrations(h.db);
  });
  afterEach(() => h.sqlite.close());

  it('is null when the integration is not installed', () => {
    expect(resolveTelegramConfig(store)).toBeNull();
  });

  it('is null when the bot token is blank', () => {
    install(h, { botToken: '' });
    expect(resolveTelegramConfig(store)).toBeNull();
  });

  it('returns the trimmed bot token when configured and enabled', () => {
    install(h, { botToken: '  123:abc  ' });
    expect(resolveTelegramConfig(store)).toEqual({ botToken: '123:abc' });
  });

  it('is null when installed but disabled', () => {
    install(h, { botToken: '123:abc' }, 0);
    expect(resolveTelegramConfig(store)).toBeNull();
  });
});
