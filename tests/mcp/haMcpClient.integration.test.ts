import { describe, it, expect } from 'vitest';
import { HaMcpClient } from '../../src/mcp/haMcpClient.ts';
import { loadEnvFile } from '../../src/config.ts';

const RUN = process.env.RUN_INTEGRATION === '1';

function getHaConfig(): { url: string; token: string } {
  loadEnvFile();

  const { HA_URL: url, HA_TOKEN: token } = process.env;
  if (!url || !token) {
    throw new Error('RUN_INTEGRATION=1 requires HA_URL and HA_TOKEN in env or repo .env');
  }
  return { url, token };
}

describe.runIf(RUN)('HaMcpClient (integration)', () => {
  it('connects, lists tools, and toggles a mock light', async () => {
    const cfg = getHaConfig();
    const client = new HaMcpClient({ url: cfg.url, token: cfg.token });
    await client.connect();
    try {
      const tools = await client.listTools();
      expect(tools.length).toBeGreaterThan(0);
      const hasTurnOn = tools.some((t) => t.name === 'HassTurnOn');
      expect(hasTurnOn).toBe(true);

      const onResult = await client.callTool('HassTurnOn', { name: 'Kitchen Light' });
      expect(onResult.isError).toBe(false);

      const offResult = await client.callTool('HassTurnOff', { name: 'Kitchen Light' });
      expect(offResult.isError).toBe(false);
    } finally {
      await client.disconnect();
    }
  }, 30_000);
});
