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
  it('telegram and http produce the same prompt (both plain text channels)', () => {
    expect(buildSystemPromptFor('telegram')).toBe(buildSystemPromptFor('http'));
  });

  it('does NOT include any structured-output format addendum (plain text replies)', () => {
    expect(buildSystemPromptFor('telegram')).not.toContain('OUTPUT FORMAT');
    expect(buildSystemPromptFor('assist')).not.toContain('OUTPUT FORMAT');
  });

  it('assist channel includes the voice addendum (TTS-friendly output)', () => {
    const prompt = buildSystemPromptFor('assist');
    expect(prompt).toContain('Voice channel');
    expect(prompt).toContain('HARD RULE — TTS-safe output');
  });

  it('telegram/http do NOT include the voice addendum', () => {
    expect(buildSystemPromptFor('telegram')).not.toContain('Voice channel');
    expect(buildSystemPromptFor('http')).not.toContain('Voice channel');
  });
});
