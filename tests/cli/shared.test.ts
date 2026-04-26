import { describe, it, expect } from 'vitest';
import { buildSystemPromptFor, parseAgentMode, AGENT_MODES } from '../../src/cli/shared.ts';

describe('parseAgentMode', () => {
  it('defaults to "both" when env is empty', () => {
    expect(parseAgentMode(undefined)).toBe('both');
    expect(parseAgentMode('')).toBe('both');
  });

  it('accepts valid modes', () => {
    for (const m of AGENT_MODES) {
      expect(parseAgentMode(m)).toBe(m);
    }
  });

  it('throws on unknown mode with helpful message', () => {
    expect(() => parseAgentMode('garbage')).toThrow(/AGENT_MODE.*garbage.*expected one of/);
  });
});

describe('buildSystemPromptFor', () => {
  it('chat returns BASE_SYSTEM_PROMPT unchanged', () => {
    const p = buildSystemPromptFor('chat');
    expect(p).not.toContain('Voice channel');
    expect(p).not.toContain('silent-confirmation');
  });

  it('voice adds the short-replies addendum', () => {
    const p = buildSystemPromptFor('voice');
    expect(p).toContain('Voice channel');
    expect(p).toContain('under 1 sentence');
  });

  it('wake adds the silent-confirmation rule', () => {
    const p = buildSystemPromptFor('wake');
    expect(p).toContain('SILENT-CONFIRMATION');
    expect(p).toContain('"direction"');
  });

  it('telegram is identical to chat (no TTS, free-form text)', () => {
    expect(buildSystemPromptFor('telegram')).toBe(buildSystemPromptFor('chat'));
  });
});
