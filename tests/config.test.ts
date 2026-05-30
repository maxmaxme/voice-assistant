import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../src/config.ts';

describe('loadConfig', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.HA_URL;
    delete process.env.HA_TOKEN;
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
    process.env.HA_URL = 'http://localhost:8123';
    process.env.HA_TOKEN = 'tok_abc';
    process.env.OPENAI_API_KEY = 'sk-xxx';
    process.env.TELEGRAM_BOT_TOKEN = 'tg_tok';
  }

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns config when both HA_URL and HA_TOKEN are set', () => {
    setRequired();
    const cfg = loadConfig();
    expect(cfg.ha.url).toBe('http://localhost:8123');
    expect(cfg.ha.token).toBe('tok_abc');
  });

  it('throws when HA_URL is missing', () => {
    setRequired();
    delete process.env.HA_URL;
    expect(() => loadConfig()).toThrow(/HA_URL/);
  });

  it('throws when HA_TOKEN is missing', () => {
    setRequired();
    delete process.env.HA_TOKEN;
    expect(() => loadConfig()).toThrow(/HA_TOKEN/);
  });

  it('reads openai api key', () => {
    setRequired();
    const cfg = loadConfig();
    expect(cfg.openai.apiKey).toBe('sk-xxx');
  });

  it('throws when OPENAI_API_KEY is missing', () => {
    setRequired();
    delete process.env.OPENAI_API_KEY;
    expect(() => loadConfig()).toThrow(/openai/i);
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

  it('realtime defaults: disabled with default port/model/voice/reasoning', () => {
    setRequired();
    const cfg = loadConfig();
    expect(cfg.realtime.enabled).toBe(false);
    expect(cfg.realtime.port).toBe(3001);
    expect(cfg.realtime.model).toBe('gpt-realtime-2');
    expect(cfg.realtime.voice).toBe('marin');
    expect(cfg.realtime.reasoningEffort).toBe('low');
  });

  it('realtime: REALTIME_ENABLED=1 with VA_DEVICE_TOKEN reads enabled+token', () => {
    setRequired();
    process.env.REALTIME_ENABLED = '1';
    process.env.VA_DEVICE_TOKEN = 'abc';
    const cfg = loadConfig();
    expect(cfg.realtime.enabled).toBe(true);
    expect(cfg.realtime.token).toBe('abc');
  });

  it('realtime: REALTIME_ENABLED=1 without VA_DEVICE_TOKEN throws', () => {
    setRequired();
    process.env.REALTIME_ENABLED = '1';
    delete process.env.VA_DEVICE_TOKEN;
    expect(() => loadConfig()).toThrow(/VA_DEVICE_TOKEN/);
  });
});
