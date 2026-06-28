import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../src/config.ts';

describe('loadConfig', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.REALTIME_PORT;
    delete process.env.HTTP_SERVER_PORT;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('realtime defaults: port 3001', () => {
    const cfg = loadConfig();
    expect(cfg.realtime.port).toBe(3001);
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
    const cfg = loadConfig({ REALTIME_PORT: '3030' });
    expect(cfg.realtime.port).toBe(3030);
  });
});
