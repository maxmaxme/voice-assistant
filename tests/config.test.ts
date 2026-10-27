import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../src/config.ts';

describe('loadConfig', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.HTTP_SERVER_PORT;
    // TZ is required; default it so the non-TZ cases can load.
    process.env.TZ = 'Europe/Madrid';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('reads TZ from env', () => {
    process.env.TZ = 'America/New_York';
    expect(loadConfig().tz).toBe('America/New_York');
  });

  it('throws when TZ is missing', () => {
    delete process.env.TZ;
    expect(() => loadConfig({})).toThrow(/TZ/);
  });

  it('http defaults: port 3000', () => {
    expect(loadConfig().http.port).toBe(3000);
  });

  it('reads http port from env', () => {
    process.env.HTTP_SERVER_PORT = '8080';
    expect(loadConfig().http.port).toBe(8080);
  });

  it('reads from a passed env map instead of process.env', () => {
    const cfg = loadConfig({ TZ: 'UTC', HTTP_SERVER_PORT: '3030' });
    expect(cfg.http.port).toBe(3030);
  });
});
