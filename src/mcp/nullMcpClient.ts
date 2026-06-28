import type { McpClient, McpTool, McpToolResult } from './types.ts';

/** A no-op MCP client used when no MCP backend is configured (e.g. the Home
 *  Assistant integration isn't installed). Exposes zero tools, so the agent
 *  simply never offers or routes to MCP. Keeping the interface satisfied means
 *  the rest of the code path stays unchanged. */
export class NullMcpClient implements McpClient {
  async connect(): Promise<void> {}

  async listTools(): Promise<McpTool[]> {
    return [];
  }

  async callTool(name: string): Promise<McpToolResult> {
    throw new Error(`No MCP backend configured; cannot call tool "${name}"`);
  }

  async disconnect(): Promise<void> {}
}
