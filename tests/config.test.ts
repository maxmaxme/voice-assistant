import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../src/config.ts';

describe('loadConfig', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.HA_URL;
    delete process.env.HA_TOKEN;
    delete process.env.OPENAI_API_KEY;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    delete process.env.HTTP_API_KEYS;
  });

  function setRequired(): void {
    process.env.HA_URL = 'http://localhost:8123';
    process.env.HA_TOKEN = 'tok_abc';
    process.env.OPENAI_API_KEY = 'sk-xxx';
    process.env.TELEGRAM_BOT_TOKEN = 'tg_tok';
    process.env.TELEGRAM_CHAT_ID = '42';
    process.env.HTTP_API_KEYS = 'test-http-key';
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

  it('reads telegram bot token and chat id', () => {
    setRequired();
    const cfg = loadConfig();
    expect(cfg.telegram.botToken).toBe('tg_tok');
    expect(cfg.telegram.chatId).toBe('42');
  });

  it('throws when TELEGRAM_BOT_TOKEN is missing', () => {
    setRequired();
    delete process.env.TELEGRAM_BOT_TOKEN;
    expect(() => loadConfig()).toThrow(/TELEGRAM_BOT_TOKEN/);
  });

  it('throws when TELEGRAM_CHAT_ID is missing', () => {
    setRequired();
    delete process.env.TELEGRAM_CHAT_ID;
    expect(() => loadConfig()).toThrow(/TELEGRAM_CHAT_ID/);
  });

  it('throws when HTTP_API_KEYS is missing', () => {
    setRequired();
    delete process.env.HTTP_API_KEYS;
    expect(() => loadConfig()).toThrow(/HTTP_API_KEYS/);
  });

  it('allowed chat ids defaults to [Number(chatId)] when TELEGRAM_ALLOWED_CHAT_IDS is unset', () => {
    setRequired();
    delete process.env.TELEGRAM_ALLOWED_CHAT_IDS;
    const cfg = loadConfig();
    expect(cfg.telegram.allowedChatIds).toEqual([42]);
  });

  it('allowed chat ids parses comma list into number array', () => {
    setRequired();
    process.env.TELEGRAM_ALLOWED_CHAT_IDS = '42, 100, -5';
    const cfg = loadConfig();
    expect(cfg.telegram.allowedChatIds).toEqual([42, 100, -5]);
  });

  it('throws on non-numeric entries in TELEGRAM_ALLOWED_CHAT_IDS', () => {
    setRequired();
    process.env.TELEGRAM_ALLOWED_CHAT_IDS = '42,abc';
    expect(() => loadConfig()).toThrow(/TELEGRAM_ALLOWED_CHAT_IDS/);
  });
});
