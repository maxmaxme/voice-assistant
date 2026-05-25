export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface RealtimeTool {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export function mcpToolsToRealtime(tools: McpTool[]): RealtimeTool[] {
  const out: RealtimeTool[] = [];
  for (const t of tools) {
    if (!t.inputSchema || !t.name) {
      continue;
    }
    out.push({
      type: 'function',
      name: t.name,
      description: t.description ?? '',
      parameters: t.inputSchema,
    });
  }
  return out;
}
