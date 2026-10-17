import { describe, it, expect, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { handleVoiceMcp, type VoiceMcpDeps } from '../../src/mcpServer/voiceMcp.ts';

function deps(overrides: Partial<VoiceMcpDeps> = {}): VoiceMcpDeps {
  return {
    authorize: (token) => (token === 'speaker-token' ? { userId: 7 } : null),
    speakerContext: async () => ({
      tools: [
        {
          type: 'function',
          name: 'HassTurnOn',
          description: 'Turns on devices',
          parameters: { type: 'object', properties: { name: { type: 'string' } } },
        },
      ],
      runTool: async (name, args) => JSON.stringify({ ran: name, args }),
      prompts: { 'voice-system': 'You are the speaker in the kitchen.' },
      realtimeConfig: { noiseReduction: 'off', requestFollowUpMs: 4000 },
    }),
    ...overrides,
  };
}

async function connect(d: VoiceMcpDeps, token = 'speaker-token'): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL('http://va.test/mcp'), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
    fetch: (url, init) => handleVoiceMcp(new Request(url, init), d),
  });
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

describe('handleVoiceMcp', () => {
  it('lists the speaker tools with their JSON schemas', async () => {
    const client = await connect(deps());
    const { tools } = await client.listTools();
    expect(tools).toEqual([
      {
        name: 'HassTurnOn',
        description: 'Turns on devices',
        inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
      },
    ]);
  });

  it('runs tools through the speaker runner', async () => {
    const client = await connect(deps());
    const result = await client.callTool({ name: 'HassTurnOn', arguments: { name: 'Lamp' } });
    expect(result.content).toEqual([
      { type: 'text', text: JSON.stringify({ ran: 'HassTurnOn', args: { name: 'Lamp' } }) },
    ]);
  });

  it('serves prompts by name and rejects unknown ones', async () => {
    const client = await connect(deps());
    expect((await client.listPrompts()).prompts).toEqual([{ name: 'voice-system' }]);
    const prompt = await client.getPrompt({ name: 'voice-system' });
    expect(prompt.messages[0]?.content).toEqual({
      type: 'text',
      text: 'You are the speaker in the kitchen.',
    });
    await expect(client.getPrompt({ name: 'nope' })).rejects.toThrow(/unknown prompt/);
  });

  it('serves the realtime config as a JSON resource', async () => {
    const client = await connect(deps());
    expect((await client.listResources()).resources).toEqual([
      { uri: 'voice://realtime-config', name: 'realtime-config', mimeType: 'application/json' },
    ]);
    const [content] = (await client.readResource({ uri: 'voice://realtime-config' })).contents;
    expect(content && 'text' in content ? JSON.parse(content.text) : null).toEqual({
      noiseReduction: 'off',
      requestFollowUpMs: 4000,
    });
    await expect(client.readResource({ uri: 'voice://nope' })).rejects.toThrow(/unknown resource/);
  });

  it('scopes the context to the authorized speaker', async () => {
    const speakerContext = vi.fn(deps().speakerContext);
    const client = await connect(deps({ speakerContext }));
    await client.listTools();
    expect(speakerContext).toHaveBeenCalledWith(7);
  });

  it('rejects an unknown device token with 401', async () => {
    const res = await handleVoiceMcp(
      new Request('http://va.test/mcp', {
        method: 'POST',
        headers: { authorization: 'Bearer nope', 'content-type': 'application/json' },
        body: '{}',
      }),
      deps(),
    );
    expect(res.status).toBe(401);
    await expect(connect(deps(), 'nope')).rejects.toThrow();
  });
});
