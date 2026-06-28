import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { freshTestDb, type TestDb } from '../memory/helpers.ts';
import { SqlitePrompts } from '../../src/settings/sqlitePrompts.ts';
import {
  initPromptRegistry,
  resolvePrompt,
  bundledPromptNames,
  resetPromptRegistry,
} from '../../src/agent/prompts/registry.ts';

describe('prompt registry', () => {
  let h: TestDb;
  let prompts: SqlitePrompts;
  beforeEach(() => {
    resetPromptRegistry();
    h = freshTestDb();
    prompts = new SqlitePrompts(h.db);
  });
  afterEach(() => {
    resetPromptRegistry();
    h.sqlite.close();
  });

  it('knows the bundled prompts, including the addenda, tools and ha-suffix', () => {
    const names = bundledPromptNames();
    expect(names).toEqual(
      expect.arrayContaining([
        'base-system',
        'voice-addendum',
        'realtime-addendum',
        'tools/remember',
        'ha-suffix/HassTurnOn',
      ]),
    );
  });

  it('seeds every bundled prompt into the DB, all non-empty', () => {
    initPromptRegistry(prompts);
    const rows = prompts.list();
    expect(rows.length).toBe(bundledPromptNames().length);
    for (const r of rows) {
      expect(r.content.trim().length).toBeGreaterThan(0);
    }
  });

  it('seedIfAbsent does not clobber an already-edited prompt', () => {
    prompts.set('base-system', 'edited by user');
    initPromptRegistry(prompts);
    expect(prompts.get('base-system')).toBe('edited by user');
  });

  it('resolvePrompt returns the DB value once registered', () => {
    prompts.set('tools/remember', 'DB version');
    initPromptRegistry(prompts);
    expect(resolvePrompt('tools/remember')).toBe('DB version');
  });

  it('resolvePrompt falls back to bundled content for a known name', () => {
    // No initPromptRegistry call here, and the row is absent — must still
    // return the bundled file content (non-empty), so tests and pre-init
    // module loads keep working.
    expect(resolvePrompt('base-system').length).toBeGreaterThan(0);
  });

  it('resolvePrompt throws for an unknown prompt', () => {
    expect(() => resolvePrompt('does-not-exist')).toThrow(/unknown prompt/i);
  });
});
