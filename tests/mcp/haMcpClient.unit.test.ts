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
});
