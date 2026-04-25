import type { McpTool } from '../mcp/types.ts';

/**
 * Internally-tagged function tool shape for the OpenAI Responses API.
 * Local tools we control are `strict: true` (guarantees valid args).
 * HA MCP tool schemas come from upstream and don't satisfy strict-mode
 * requirements (no `additionalProperties: false`, optional fields), so
 * we keep them on `strict: false`.
 */
export interface OpenAiFunctionTool {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict?: boolean;
}

export function mcpToolsToOpenAi(tools: McpTool[]): OpenAiFunctionTool[] {
  return tools.map((t) => ({
    type: 'function',
    name: t.name,
    description: t.description,
    parameters: t.inputSchema,
    strict: false,
  }));
}
