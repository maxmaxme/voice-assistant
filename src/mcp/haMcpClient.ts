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
  private sdk: SdkLike | null = null;
  private readonly factory: (opts: { url: string; token: string }) => SdkLike;
  private readonly clientOpts: { url: string; token: string };

  constructor(opts: HaMcpClientOptions) {
    this.factory = opts.sdkClientFactory ?? defaultSdkClientFactory;
    this.clientOpts = { url: opts.url, token: opts.token };
  }

  async connect(): Promise<void> {
    // Build a FRESH client + transport on every attempt. The SDK's
    // StreamableHTTPClientTransport can only be started once — calling
    // connect() again on a transport whose first start failed throws
    // "transport already started" / "Already connected to a transport".
    // That made the retry loop in shared.ts unable to recover from ANY
    // transient first-attempt failure (wrong HA_URL, or HA not up yet at
    // boot): the first failure poisoned every subsequent retry. A new
    // transport per attempt makes the retries actually retry.
    const sdk = this.factory(this.clientOpts);
    await sdk.connect();
    this.sdk = sdk;
  }

  private requireSdk(): SdkLike {
    if (this.sdk === null) {
      throw new Error('HaMcpClient used before a successful connect()');
    }
    return this.sdk;
  }

  async listTools(): Promise<McpTool[]> {
    const res = await this.requireSdk().listTools();
    return res.tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    return this.requireSdk().callTool({ name, arguments: args });
  }

  async disconnect(): Promise<void> {
    if (this.sdk !== null) {
      await this.sdk.close();
    }
  }
}
