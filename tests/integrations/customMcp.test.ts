import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { freshTestDb, type TestDb } from '../memory/helpers.ts';
import { SqliteIntegrations } from '../../src/integrations/sqliteIntegrations.ts';
import { resolveCustomMcpConfigs } from '../../src/integrations/customMcp.ts';
import { integrations } from '../../src/memory/schema.ts';

function install(h: TestDb, type: string, config: Record<string, string>, enabled = 1): void {
  h.db
    .insert(integrations)
    .values({ type, config: JSON.stringify(config), enabled, updatedAt: Date.now() })
    .run();
}

describe('resolveCustomMcpConfigs', () => {
  let h: TestDb;
  let store: SqliteIntegrations;
  beforeEach(() => {
    h = freshTestDb();
    store = new SqliteIntegrations(h.db);
  });
  afterEach(() => h.sqlite.close());

  it('returns enabled mcp:* rows with a url, parsing the tool filter', () => {
    install(h, 'home-assistant', { url: 'http://ha', token: 't' });
    install(h, 'mcp:zen', {
      url: ' http://zen/mcp ',
      token: 'tok',
      toolMode: 'only',
      tools: 'a, b\nc',
    });
    install(h, 'mcp:open', { url: 'http://open/mcp' });
    install(h, 'mcp:off', { url: 'http://off/mcp' }, 0);
    install(h, 'mcp:blank', { url: '' });
    expect(resolveCustomMcpConfigs(store)).toEqual([
      { name: 'zen', url: 'http://zen/mcp', token: 'tok', tools: ['a', 'b', 'c'], only: true },
      { name: 'open', url: 'http://open/mcp', tools: [], only: false },
    ]);
  });
});
