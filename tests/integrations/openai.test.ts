import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { freshTestDb, type TestDb } from '../memory/helpers.ts';
import { SqliteIntegrations } from '../../src/integrations/sqliteIntegrations.ts';
import { resolveOpenAiConfig, OPENAI_INTEGRATION_TYPE } from '../../src/integrations/openai.ts';
import { integrations } from '../../src/memory/schema.ts';

function install(h: TestDb, config: Record<string, string>, enabled = 1): void {
  h.db
    .insert(integrations)
    .values({
      type: OPENAI_INTEGRATION_TYPE,
      config: JSON.stringify(config),
      enabled,
      updatedAt: Date.now(),
    })
    .run();
}

describe('resolveOpenAiConfig', () => {
  let h: TestDb;
  let store: SqliteIntegrations;
  beforeEach(() => {
    h = freshTestDb();
    store = new SqliteIntegrations(h.db);
  });
  afterEach(() => h.sqlite.close());

  it('is null when not installed', () => {
    expect(resolveOpenAiConfig(store)).toBeNull();
  });

  it('is null when installed but disabled', () => {
    install(h, { apiKey: 'sk-x' }, 0);
    expect(resolveOpenAiConfig(store)).toBeNull();
  });

  it('is null when the API key is blank', () => {
    install(h, { apiKey: '' });
    expect(resolveOpenAiConfig(store)).toBeNull();
  });

  it('applies defaults for unset fields', () => {
    install(h, { apiKey: 'sk-x' });
    expect(resolveOpenAiConfig(store)).toEqual({
      apiKey: 'sk-x',
      baseUrl: undefined,
      model: 'gpt-5-mini',
      reasoningEffort: 'low',
      webSearch: false,
      realtime: { model: 'gpt-realtime-2', voice: 'marin', reasoningEffort: 'low' },
    });
  });

  it('reads configured values, coercing booleans and efforts', () => {
    install(h, {
      apiKey: 'sk-x',
      baseUrl: 'https://proxy/v1',
      model: 'gpt-6',
      reasoningEffort: 'high',
      webSearch: '1',
      realtimeModel: 'rt-9',
      realtimeVoice: 'cedar',
      realtimeReasoningEffort: 'xhigh',
    });
    expect(resolveOpenAiConfig(store)).toEqual({
      apiKey: 'sk-x',
      baseUrl: 'https://proxy/v1',
      model: 'gpt-6',
      reasoningEffort: 'high',
      webSearch: true,
      realtime: { model: 'rt-9', voice: 'cedar', reasoningEffort: 'xhigh' },
    });
  });

  it('falls back to low for an out-of-range effort', () => {
    install(h, { apiKey: 'sk-x', reasoningEffort: 'bogus' });
    expect(resolveOpenAiConfig(store)?.reasoningEffort).toBe('low');
  });
});
