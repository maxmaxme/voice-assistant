import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { freshTestDb, type TestDb } from '../memory/helpers.ts';
import { SqliteIntegrations } from '../../src/integrations/sqliteIntegrations.ts';
import { resolveHaConfig, HA_INTEGRATION_TYPE } from '../../src/integrations/homeAssistant.ts';
import { integrations } from '../../src/memory/schema.ts';

function install(h: TestDb, config: Record<string, string>, enabled = 1): void {
  h.db
    .insert(integrations)
    .values({
      type: HA_INTEGRATION_TYPE,
      config: JSON.stringify(config),
      enabled,
      updatedAt: Date.now(),
    })
    .run();
}

describe('resolveHaConfig', () => {
  let h: TestDb;
  let store: SqliteIntegrations;
  beforeEach(() => {
    h = freshTestDb();
    store = new SqliteIntegrations(h.db);
  });
  afterEach(() => h.sqlite.close());

  it('is null when the integration is not installed', () => {
    expect(resolveHaConfig(store)).toBeNull();
  });

  it('is null when url or token is blank', () => {
    install(h, { url: '', token: 'tok' });
    expect(resolveHaConfig(store)).toBeNull();
  });

  it('returns trimmed url and token when configured and enabled', () => {
    install(h, { url: '  http://ha:8123  ', token: ' tok ' });
    expect(resolveHaConfig(store)).toEqual({ url: 'http://ha:8123', token: 'tok' });
  });

  it('strips a trailing slash from the url', () => {
    install(h, { url: 'http://ha:8123/', token: 'tok' });
    expect(resolveHaConfig(store)?.url).toBe('http://ha:8123');
  });

  it('is null when installed but disabled', () => {
    install(h, { url: 'http://ha:8123', token: 'tok' }, 0);
    expect(resolveHaConfig(store)).toBeNull();
  });
});
