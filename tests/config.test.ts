import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../src/config.ts';

describe('loadConfig', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.REALTIME_PORT;
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

  it('realtime defaults: port 3001', () => {
    expect(loadConfig().realtime.port).toBe(3001);
  });

  it('reads realtime port from env', () => {
    process.env.REALTIME_PORT = '3009';
    expect(loadConfig().realtime.port).toBe(3009);
  });

  it('http defaults: port 3000', () => {
    expect(loadConfig().http.port).toBe(3000);
  });

  it('reads http port from env', () => {
    process.env.HTTP_SERVER_PORT = '8080';
    expect(loadConfig().http.port).toBe(8080);
  });

  it('reads from a passed env map instead of process.env', () => {
    const cfg = loadConfig({ TZ: 'UTC', REALTIME_PORT: '3030' });
    expect(cfg.realtime.port).toBe(3030);
  });
});
