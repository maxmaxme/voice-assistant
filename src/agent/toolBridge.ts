import type { McpTool } from '../mcp/types.ts';
import { resolvePrompt } from './prompts/registry.ts';

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
const HA_SUFFIX_TOOLS: ReadonlySet<string> = new Set([
  'HassTurnOn',
  'HassTurnOff',
  'HassClimateSetTemperature',
  'HassListAddItem',
  'HassListRemoveItem',
  'GetLiveContext',
]);

/** The (possibly web-edited) suffix for an HA tool, or undefined when the tool
 *  has none. Resolved at call time so DB edits take effect. */
function haSuffixFor(toolName: string): string | undefined {
  return HA_SUFFIX_TOOLS.has(toolName) ? resolvePrompt(`ha-suffix/${toolName}`) : undefined;
}

/** Merge per-tool prompt suffixes into the MCP descriptions before either the
 * Responses-API or Realtime tool adapter sees them. Both code paths reach for
 * the same suffix map so a rule written once applies on every channel. */
export function applyHaToolSuffixes<T extends { name: string; description?: string }>(
  tools: T[],
): T[] {
  return tools.map((t) => {
    const suffix = haSuffixFor(t.name);
    if (!suffix) {
      return t;
    }
    const base = t.description ?? '';
    return { ...t, description: base ? `${base}\n\n${suffix}` : suffix };
  });
}

export function mcpToolsToOpenAi(tools: McpTool[]): OpenAiFunctionTool[] {
  return applyHaToolSuffixes(tools).map((t) => ({
    type: 'function',
    name: t.name,
    description: t.description ?? '',
    parameters: t.inputSchema,
    strict: false,
  }));
}
