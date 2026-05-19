import type { McpTool } from '../mcp/types.ts';
import { loadPrompt } from './prompts/load.ts';

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

/**
 * Per-tool behavioural rules we want the model to see whenever it looks at
 * an HA MCP tool. Upstream HA descriptions are minimal ("Turns on devices
 * or entities") and don't encode the conventions we care about (mode
 * mapping for climate, grocery item formatting for todo lists, etc.).
 *
 * Each entry is a markdown fragment loaded from `prompts/ha-suffix/<name>.md`
 * — easier to edit than escaped string literals.
 *
 * Rule of thumb: if a rule applies to ONE HA tool, put it here. If it
 * applies across many tools (recovery procedure, composite-intent
 * self-check), put it in BASE_SYSTEM_PROMPT.
 */
const HA_SUFFIX_TOOLS = [
  'HassClimateSetTemperature',
  'HassTurnOn',
  'HassListAddItem',
  'GetLiveContext',
] as const;

const HA_TOOL_DESCRIPTION_SUFFIX: Readonly<Record<string, string>> = Object.fromEntries(
  HA_SUFFIX_TOOLS.map((name) => [
    name,
    loadPrompt(`./prompts/ha-suffix/${name}.md`, import.meta.url),
  ]),
);

export function mcpToolsToOpenAi(tools: McpTool[]): OpenAiFunctionTool[] {
  return tools.map((t) => {
    const base = t.description ?? '';
    const suffix = HA_TOOL_DESCRIPTION_SUFFIX[t.name];
    return {
      type: 'function',
      name: t.name,
      description: suffix ? `${base}\n\n${suffix}` : base,
      parameters: t.inputSchema,
      strict: false,
    };
  });
}
