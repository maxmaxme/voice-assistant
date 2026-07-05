import { describe, it, expect, vi } from 'vitest';
import { HaMcpClient } from '../../src/mcp/haMcpClient.ts';

function makeFakeSdkClient() {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue({
      tools: [
        {
          name: 'HassTurnOn',
          description: 'Turn on an entity',
          inputSchema: { type: 'object' },
        },
      ],
    }),
    callTool: vi.fn().mockResolvedValue({
      isError: false,
      content: [{ type: 'text', text: 'ok' }],
    }),
  };
}

describe('HaMcpClient', () => {
  it('connect() delegates to the underlying SDK client', async () => {
    const sdk = makeFakeSdkClient();
    const client = new HaMcpClient({
      url: 'http://h:8123',
      token: 't',
      sdkClientFactory: () => sdk,
    });
    await client.connect();
    expect(sdk.connect).toHaveBeenCalledOnce();
  });

  it('listTools() returns mapped tools', async () => {
    const sdk = makeFakeSdkClient();
    const client = new HaMcpClient({
      url: 'http://h:8123',
      token: 't',
      sdkClientFactory: () => sdk,
    });
    await client.connect();
    const tools = await client.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('HassTurnOn');
  });

  it('callTool() returns mapped result', async () => {
    const sdk = makeFakeSdkClient();
    const client = new HaMcpClient({
      url: 'http://h:8123',
      token: 't',
      sdkClientFactory: () => sdk,
    });
    await client.connect();
    const result = await client.callTool('HassTurnOn', { entity_id: 'light.x' });
    expect(result.isError).toBe(false);
    expect(sdk.callTool).toHaveBeenCalledWith({
      name: 'HassTurnOn',
      arguments: { entity_id: 'light.x' },
    });
  });

  it('disconnect() closes the SDK client', async () => {
    const sdk = makeFakeSdkClient();
    const client = new HaMcpClient({
      url: 'http://h:8123',
      token: 't',
      sdkClientFactory: () => sdk,
    });
    await client.connect();
    await client.disconnect();
    expect(sdk.close).toHaveBeenCalledOnce();
  });

  describe('mid-run reconnect', () => {
    it('reconnects once and retries when callTool throws (dead session)', async () => {
      const dead = makeFakeSdkClient();
      dead.callTool.mockRejectedValue(new Error('fetch failed'));
      const fresh = makeFakeSdkClient();
      const factory = vi.fn().mockReturnValueOnce(dead).mockReturnValueOnce(fresh);
      const client = new HaMcpClient({
        url: 'http://h:8123',
        token: 't',
        sdkClientFactory: factory,
      });
      await client.connect();

      const result = await client.callTool('HassTurnOn', { entity_id: 'light.x' });

      expect(result.isError).toBe(false);
      expect(factory).toHaveBeenCalledTimes(2);
      expect(dead.close).toHaveBeenCalledOnce();
      expect(fresh.connect).toHaveBeenCalledOnce();
      expect(fresh.callTool).toHaveBeenCalledWith({
        name: 'HassTurnOn',
        arguments: { entity_id: 'light.x' },
      });
    });

    it('reconnects once and retries when listTools throws', async () => {
      const dead = makeFakeSdkClient();
      dead.listTools.mockRejectedValue(new Error('socket hang up'));
      const fresh = makeFakeSdkClient();
      const factory = vi.fn().mockReturnValueOnce(dead).mockReturnValueOnce(fresh);
      const client = new HaMcpClient({
        url: 'http://h:8123',
        token: 't',
        sdkClientFactory: factory,
      });
      await client.connect();

      const tools = await client.listTools();

      expect(tools).toHaveLength(1);
      expect(fresh.listTools).toHaveBeenCalledOnce();
    });

    it('shares one in-flight reconnect between concurrent failures', async () => {
      const dead = makeFakeSdkClient();
      dead.callTool.mockRejectedValue(new Error('fetch failed'));
      const fresh = makeFakeSdkClient();
      const factory = vi.fn().mockReturnValueOnce(dead).mockReturnValueOnce(fresh);
      const client = new HaMcpClient({
        url: 'http://h:8123',
        token: 't',
        sdkClientFactory: factory,
      });
      await client.connect();

      const [a, b] = await Promise.all([
        client.callTool('HassTurnOn', { entity_id: 'light.a' }),
        client.callTool('HassTurnOff', { entity_id: 'light.b' }),
      ]);

      expect(a.isError).toBe(false);
      expect(b.isError).toBe(false);
      // Initial connect + a single shared reconnect — not one per failure.
      expect(factory).toHaveBeenCalledTimes(2);
      expect(fresh.connect).toHaveBeenCalledOnce();
      expect(fresh.callTool).toHaveBeenCalledTimes(2);
    });

    it('throws when the retry after reconnect also fails', async () => {
      const dead = makeFakeSdkClient();
      dead.callTool.mockRejectedValue(new Error('fetch failed'));
      const stillDead = makeFakeSdkClient();
      stillDead.callTool.mockRejectedValue(new Error('still down'));
      const factory = vi.fn().mockReturnValueOnce(dead).mockReturnValueOnce(stillDead);
      const client = new HaMcpClient({
        url: 'http://h:8123',
        token: 't',
        sdkClientFactory: factory,
      });
      await client.connect();

      await expect(client.callTool('HassTurnOn', {})).rejects.toThrow('still down');
      // Exactly one reconnect attempt — no retry storm.
      expect(factory).toHaveBeenCalledTimes(2);
    });

    it('throws the original error when the reconnect itself fails', async () => {
      const dead = makeFakeSdkClient();
      dead.callTool.mockRejectedValue(new Error('fetch failed'));
      const unreachable = makeFakeSdkClient();
      unreachable.connect.mockRejectedValue(new Error('ECONNREFUSED'));
      const factory = vi.fn().mockReturnValueOnce(dead).mockReturnValueOnce(unreachable);
      const client = new HaMcpClient({
        url: 'http://h:8123',
        token: 't',
        sdkClientFactory: factory,
      });
      await client.connect();

      await expect(client.callTool('HassTurnOn', {})).rejects.toThrow('fetch failed');
    });

    it('recovers on the next call after a failed reconnect', async () => {
      const dead = makeFakeSdkClient();
      dead.callTool.mockRejectedValue(new Error('fetch failed'));
      const unreachable = makeFakeSdkClient();
      unreachable.connect.mockRejectedValue(new Error('ECONNREFUSED'));
      const fresh = makeFakeSdkClient();
      const factory = vi
        .fn()
        .mockReturnValueOnce(dead)
        .mockReturnValueOnce(unreachable)
        .mockReturnValueOnce(fresh);
      const client = new HaMcpClient({
        url: 'http://h:8123',
        token: 't',
        sdkClientFactory: factory,
      });
      await client.connect();

      await expect(client.callTool('HassTurnOn', {})).rejects.toThrow('fetch failed');
      const result = await client.callTool('HassTurnOn', {});
      expect(result.isError).toBe(false);
      expect(fresh.callTool).toHaveBeenCalledOnce();
    });
  });
});
