import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { freshTestDb, type TestDb } from '../memory/helpers.ts';
import { SqlitePrompts } from '../../src/settings/sqlitePrompts.ts';
import {
  initPromptRegistry,
  resolvePrompt,
  bundledPromptNames,
  resetPromptRegistry,
} from '../../src/agent/prompts/registry.ts';

const AGENT_PROMPTS = new URL('../../src/agent/prompts/', import.meta.url);
const CLI_PROMPTS = new URL('../../src/cli/prompts/', import.meta.url);

function bundledFile(dir: URL, relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, dir)), 'utf8').trim();
}

describe('prompt registry (agent)', () => {
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

  describe('discovery + seeding', () => {
    it('discovers the known prompt names across all prompt dirs', () => {
      expect(bundledPromptNames()).toEqual(
        expect.arrayContaining([
          'base-system',
          'ha-addendum',
          'tools/remember',
          'tools/wait-for-user',
          'voice-addendum',
        ]),
      );
    });

    it('seeds every bundled prompt: default_content = bundled text, content = sentinel', () => {
      initPromptRegistry(prompts);
      const rows = new Map(prompts.list().map((r) => [r.name, r]));
      expect(rows.size).toBe(bundledPromptNames().length);

      const expected: Array<[string, string]> = [
        ['base-system', bundledFile(AGENT_PROMPTS, 'base-system.md')],
        ['ha-addendum', bundledFile(AGENT_PROMPTS, 'ha-addendum.md')],
        ['tools/remember', bundledFile(AGENT_PROMPTS, 'tools/remember.md')],
        ['tools/wait-for-user', bundledFile(AGENT_PROMPTS, 'tools/wait-for-user.md')],
        ['voice-addendum', bundledFile(CLI_PROMPTS, 'voice-addendum.md')],
      ];
      for (const [name, text] of expected) {
        const row = rows.get(name);
        expect(row, name).toBeDefined();
        expect(row?.content, name).toBe('');
        expect(row?.defaultContent, name).toBe(text);
      }
    });
  });

  describe('resolvePrompt fallback', () => {
    it('returns the DB content when the user edited a seeded prompt', () => {
      initPromptRegistry(prompts);
      prompts.set('tools/remember', 'customized via web');
      expect(resolvePrompt('tools/remember')).toBe('customized via web');
    });

    it('falls back to the bundled text when content is the empty sentinel', () => {
      initPromptRegistry(prompts);
      expect(resolvePrompt('base-system')).toBe(bundledFile(AGENT_PROMPTS, 'base-system.md'));
    });

    it('falls back to the bundled text after "Reset to default" clears an edit', () => {
      initPromptRegistry(prompts);
      prompts.set('voice-addendum', 'edited');
      prompts.resetToDefault('voice-addendum');
      expect(resolvePrompt('voice-addendum')).toBe(bundledFile(CLI_PROMPTS, 'voice-addendum.md'));
    });
  });

  describe('default refresh on re-init', () => {
    it('refreshes default_content but never clobbers a user edit', () => {
      initPromptRegistry(prompts);
      prompts.set('base-system', 'my custom system prompt');

      // Second process start against the same DB.
      initPromptRegistry(prompts);

      const row = prompts.list().find((r) => r.name === 'base-system');
      expect(row?.content).toBe('my custom system prompt');
      expect(row?.defaultContent).toBe(bundledFile(AGENT_PROMPTS, 'base-system.md'));
      expect(resolvePrompt('base-system')).toBe('my custom system prompt');
    });

    it('keeps un-edited prompts on the empty sentinel across re-init', () => {
      initPromptRegistry(prompts);
      initPromptRegistry(prompts);
      const row = prompts.list().find((r) => r.name === 'tools/wait-for-user');
      expect(row?.content).toBe('');
      expect(resolvePrompt('tools/wait-for-user')).toBe(
        bundledFile(AGENT_PROMPTS, 'tools/wait-for-user.md'),
      );
    });
  });

  describe('without initPromptRegistry', () => {
    it('resolvePrompt serves the bundled text (unit tests rely on this)', () => {
      expect(resolvePrompt('tools/remember')).toBe(bundledFile(AGENT_PROMPTS, 'tools/remember.md'));
    });
  });

  describe('unknown name', () => {
    it('throws for a name that is neither in the DB nor bundled', () => {
      initPromptRegistry(prompts);
      expect(() => resolvePrompt('nope/nothing')).toThrow('Unknown prompt: nope/nothing');
    });

    it('throws pre-init too', () => {
      expect(() => resolvePrompt('nope/nothing')).toThrow('Unknown prompt: nope/nothing');
    });
  });
});
