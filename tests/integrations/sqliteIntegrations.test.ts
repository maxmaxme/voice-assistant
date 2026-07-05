import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { freshTestDb, type TestDb } from '../memory/helpers.ts';
import { SqliteIntegrations } from '../../src/integrations/sqliteIntegrations.ts';
import { integrations } from '../../src/memory/schema.ts';

describe('SqliteIntegrations', () => {
  let h: TestDb;
  let store: SqliteIntegrations;
  beforeEach(() => {
    h = freshTestDb();
    store = new SqliteIntegrations(h.db);
  });
  afterEach(() => h.sqlite.close());

  it('returns null when the integration is not installed', () => {
    expect(store.get('home-assistant')).toBeNull();
  });

  it('parses the stored config JSON and enabled flag', () => {
    h.db
      .insert(integrations)
      .values({
        type: 'home-assistant',
        config: JSON.stringify({ url: 'http://ha:8123', token: 'tok' }),
        enabled: 1,
        updatedAt: Date.now(),
      })
      .run();
    expect(store.get('home-assistant')).toEqual({
      config: { url: 'http://ha:8123', token: 'tok' },
      enabled: true,
    });
  });

  it('reports enabled=false for a disabled integration', () => {
    h.db
      .insert(integrations)
      .values({ type: 'home-assistant', config: '{}', enabled: 0, updatedAt: Date.now() })
      .run();
    expect(store.get('home-assistant')?.enabled).toBe(false);
  });

  it('returns null for malformed config JSON', () => {
    h.db
      .insert(integrations)
      .values({ type: 'broken', config: 'not json', updatedAt: Date.now() })
      .run();
    expect(store.get('broken')).toBeNull();
  });

  // The DB is also hand-edited via the sqlite-web CRUD UI: valid JSON that is
  // not a string→string object must not crash-loop the bootstrap
  // (resolveOpenAiConfig does `(c.apiKey ?? '').trim()` on the result).
  describe('corrupt config shapes (hand-edited DB)', () => {
    function insert(type: string, config: string): void {
      h.db.insert(integrations).values({ type, config, enabled: 1, updatedAt: Date.now() }).run();
    }

    it('returns null when config JSON is not an object', () => {
      insert('str', '"just a string"');
      insert('num', '42');
      insert('arr', '["a","b"]');
      insert('nul', 'null');
      expect(store.get('str')).toBeNull();
      expect(store.get('num')).toBeNull();
      expect(store.get('arr')).toBeNull();
      expect(store.get('nul')).toBeNull();
    });

    it('drops non-string values so every surviving entry is a string', () => {
      insert('openai', JSON.stringify({ apiKey: 'sk-x', count: 7, nested: { a: 1 }, ok: 'y' }));
      expect(store.get('openai')).toEqual({
        config: { apiKey: 'sk-x', ok: 'y' },
        enabled: true,
      });
    });
  });
});
