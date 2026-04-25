import { describe, it, expect } from 'vitest';
import { HaMcpClient } from '../../src/mcp/haMcpClient.ts';
import { loadConfig } from '../../src/config.ts';

const RUN = process.env.RUN_INTEGRATION === '1';

describe.runIf(RUN)('HaMcpClient (integration)', () => {
  it('connects, lists tools, and toggles the test lamp', async () => {
    const cfg = loadConfig();
    const client = new HaMcpClient({ url: cfg.ha.url, token: cfg.ha.token });
    await client.connect();
    try {
      const tools = await client.listTools();
      expect(tools.length).toBeGreaterThan(0);
      const hasTurnOn = tools.some((t) => t.name === 'HassTurnOn');
      expect(hasTurnOn).toBe(true);

      const onResult = await client.callTool('HassTurnOn', { name: 'Test Lamp' });
      expect(onResult.isError).toBe(false);

      const offResult = await client.callTool('HassTurnOff', { name: 'Test Lamp' });
      expect(offResult.isError).toBe(false);
    } finally {
      await client.disconnect();
    }
  }, 30_000);
});
