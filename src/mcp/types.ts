export interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolResult {
  isError?: boolean;
  [x: string]: unknown;
}

export interface McpClient {
  connect(): Promise<void>;
  listTools(): Promise<McpTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult>;
  disconnect(): Promise<void>;
}
