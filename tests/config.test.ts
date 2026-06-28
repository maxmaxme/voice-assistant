import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../src/config.ts';

describe('loadConfig', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.REALTIME_ENABLED;
    delete process.env.REALTIME_PORT;
    delete process.env.VA_DEVICE_TOKEN;
    delete process.env.OPENAI_REALTIME_MODEL;
    delete process.env.OPENAI_REALTIME_VOICE;
    delete process.env.OPENAI_REALTIME_REASONING_EFFORT;
  });

  function setRequired(): void {
    process.env.OPENAI_API_KEY = 'sk-xxx';
    process.env.TELEGRAM_BOT_TOKEN = 'tg_tok';
  }

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('reads telegram bot token', () => {
    setRequired();
    const cfg = loadConfig();
    expect(cfg.telegram.botToken).toBe('tg_tok');
  });

  it('throws when TELEGRAM_BOT_TOKEN is missing', () => {
    setRequired();
    delete process.env.TELEGRAM_BOT_TOKEN;
    expect(() => loadConfig()).toThrow(/TELEGRAM_BOT_TOKEN/);
  });

  it('realtime defaults: port 3001, empty token', () => {
    setRequired();
    const cfg = loadConfig();
    expect(cfg.realtime.port).toBe(3001);
    expect(cfg.realtime.token).toBe('');
  });

  it('reads realtime port + device token from env', () => {
    setRequired();
    process.env.REALTIME_PORT = '3009';
    process.env.VA_DEVICE_TOKEN = 'abc';
    const cfg = loadConfig();
    expect(cfg.realtime.port).toBe(3009);
    expect(cfg.realtime.token).toBe('abc');
  });

  it('reads from a passed env map instead of process.env', () => {
    const env = {
      TELEGRAM_BOT_TOKEN: 'tg',
      REALTIME_PORT: '3030',
    };
    const cfg = loadConfig(env);
    expect(cfg.realtime.port).toBe(3030);
  });
});
