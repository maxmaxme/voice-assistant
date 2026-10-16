import type { OpenAiFunctionTool } from '../agent/toolBridge.ts';

export interface RealtimeTool {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** The Realtime API takes the Responses-API function-tool shape minus `strict`,
 *  so both HA tools (via `mcpToolsToOpenAi`) and local tools come through here. */
export function toRealtimeTools(tools: OpenAiFunctionTool[]): RealtimeTool[] {
  return tools.map(({ type, name, description, parameters }) => ({
    type,
    name,
    description,
    parameters,
  }));
}
