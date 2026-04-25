import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../src/config.ts';

describe('loadConfig', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.HA_URL;
    delete process.env.HA_TOKEN;
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns config when both HA_URL and HA_TOKEN are set', () => {
    process.env.HA_URL = 'http://localhost:8123';
    process.env.HA_TOKEN = 'tok_abc';
    process.env.OPENAI_API_KEY = 'sk-xxx';
    const cfg = loadConfig();
    expect(cfg.ha.url).toBe('http://localhost:8123');
    expect(cfg.ha.token).toBe('tok_abc');
  });

  it('throws when HA_URL is missing', () => {
    process.env.HA_TOKEN = 'tok_abc';
    process.env.OPENAI_API_KEY = 'sk-xxx';
    expect(() => loadConfig()).toThrow(/HA_URL/);
  });

  it('throws when HA_TOKEN is missing', () => {
    process.env.HA_URL = 'http://localhost:8123';
    process.env.OPENAI_API_KEY = 'sk-xxx';
    expect(() => loadConfig()).toThrow(/HA_TOKEN/);
  });

  it('reads openai api key', () => {
    process.env.HA_URL = 'http://localhost:8123';
    process.env.HA_TOKEN = 'tok_abc';
    process.env.OPENAI_API_KEY = 'sk-xxx';
    const cfg = loadConfig();
    expect(cfg.openai.apiKey).toBe('sk-xxx');
  });

  it('throws when OPENAI_API_KEY is missing', () => {
    process.env.HA_URL = 'http://localhost:8123';
    process.env.HA_TOKEN = 'tok_abc';
    delete process.env.OPENAI_API_KEY;
    expect(() => loadConfig()).toThrow(/openai/i);
  });
});
