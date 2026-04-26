import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpClient, McpTool, McpToolResult } from './types.ts';

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
  const client = new Client({ name: 'voice-assistant', version: '0.1.0' }, { capabilities: {} });
  // The SDK types `listTools`/`callTool` results against its own zod schemas;
  // the shapes are structurally compatible with our McpTool / McpToolResult.
  // We use targeted assertions here at the SDK boundary — this is the one
  // place in the codebase allowed to bridge SDK schema types into ours.
  return {
    connect: () => client.connect(transport),
    close: () => client.close(),
    listTools: () => client.listTools(),
    callTool: (req) => client.callTool(req),
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
