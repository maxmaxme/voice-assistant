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

/** Convert our `OpenAiFunctionTool`-shaped local tools (memory/weather/etc.)
 * into the Realtime API's tool shape. Same wire format as MCP-derived tools,
 * just sourced from the in-process registry instead of the MCP server. */
export function localToolsToRealtime(
  tools: { name: string; description: string; parameters: Record<string, unknown> }[],
): RealtimeTool[] {
  return tools.map((t) => ({
    type: 'function',
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
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
