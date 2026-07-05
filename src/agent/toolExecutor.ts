import type { LocalToolset } from './localTools.ts';
import type { McpClient } from '../mcp/types.ts';
import { isValidContent } from '../utils/mcpContent.ts';

export interface ToolExecution {
  /** Payload for the model: JSON for local tools, extracted text for MCP,
   *  the error message when isError. */
  text: string;
  isError: boolean;
}

/**
 * The single local-vs-MCP routing used by every channel (the Responses-API
 * agent loop and the realtime bridge). Never throws — failures come back as
 * `isError` so each channel applies its own error formatting (`ERROR:` +
 * recovery hint on the agent, `{"error": …}` JSON on realtime).
 */
export async function executeRoutedTool(
  localToolset: LocalToolset,
  mcp: McpClient,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolExecution> {
  if (localToolset.names.has(name)) {
    try {
      return { text: JSON.stringify(await localToolset.execute(name, args)), isError: false };
    } catch (e) {
      return { text: e instanceof Error ? e.message : String(e), isError: true };
    }
  }
  try {
    const result = await mcp.callTool(name, args);
    if (!isValidContent(result.content)) {
      throw new Error('Invalid content');
    }
    return {
      text: result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n'),
      isError: result.isError ?? false,
    };
  } catch (e) {
    return { text: e instanceof Error ? e.message : String(e), isError: true };
  }
}
