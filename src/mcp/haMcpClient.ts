import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpClient, McpTool, McpToolResult } from './types.js';

interface SdkLike {
  connect: (transport?: unknown) => Promise<void>;
  close: () => Promise<void>;
  listTools: () => Promise<{ tools: McpTool[] }>;
  callTool: (req: { name: string; arguments: Record<string, unknown> }) => Promise<McpToolResult>;
}

export interface HaMcpClientOptions {
  url: string;
  token: string;
  /** For tests: inject a fake SDK client. Defaults to the real one. */
  sdkClientFactory?: (opts: { url: string; token: string }) => SdkLike;
}

function defaultSdkClientFactory({ url, token }: { url: string; token: string }): SdkLike {
  const transport = new StreamableHTTPClientTransport(new URL(`${url}/api/mcp`), {
    requestInit: {
      headers: { Authorization: `Bearer ${token}` },
    },
  });
  const client = new Client(
    { name: 'voice-assistant', version: '0.1.0' },
    { capabilities: {} },
  );
  return {
    connect: () => client.connect(transport),
    close: () => client.close(),
    listTools: () => client.listTools() as Promise<{ tools: McpTool[] }>,
    callTool: (req) => client.callTool(req) as Promise<McpToolResult>,
  };
}

export class HaMcpClient implements McpClient {
  private sdk: SdkLike;

  constructor(opts: HaMcpClientOptions) {
    const factory = opts.sdkClientFactory ?? defaultSdkClientFactory;
    this.sdk = factory({ url: opts.url, token: opts.token });
  }

  async connect(): Promise<void> {
    await this.sdk.connect();
  }

  async listTools(): Promise<McpTool[]> {
    const res = await this.sdk.listTools();
    return res.tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    return this.sdk.callTool({ name, arguments: args });
  }

  async disconnect(): Promise<void> {
    await this.sdk.close();
  }
}
