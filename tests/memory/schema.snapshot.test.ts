import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { freshTestDb, type TestDb } from './helpers.ts';

describe('fresh DB schema', () => {
  let h: TestDb;
  beforeEach(() => {
    h = freshTestDb();
  });
  afterEach(() => h.sqlite.close());

  const tableNames = (h: TestDb): string[] =>
    h.sqlite
      .prepare<[], { name: string }>(
        `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`,
      )
      .all()
      .map((r) => r.name);

  it('creates all domain tables', () => {
    expect(tableNames(h)).toEqual(
      expect.arrayContaining([
        'identities',
        'integrations',
        'profile',
        'prompts',
        'runtime_state',
        'scheduled_actions',
        'settings',
        'telegram_sessions',
        'users',
      ]),
    );
  });

  it('creates the partial due index', () => {
    const idx = h.sqlite
      .prepare<
        [],
        { name: string }
      >(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_scheduled_actions_due'`)
      .get();
    expect(idx?.name).toBe('idx_scheduled_actions_due');
  });
});
