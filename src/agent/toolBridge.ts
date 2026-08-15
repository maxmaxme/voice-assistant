import type { McpTool } from '../mcp/types.ts';
import { isRecord, isStringArray } from '../utils/guards.ts';
import { createLogger } from '../utils/logger.ts';
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
  'ac_control',
  'HassListAddItem',
  'HassListRemoveItem',
  'GetLiveContext',
]);

/** The (possibly web-edited) suffix for an HA tool, or undefined when the tool
 *  has none. Resolved at call time so DB edits take effect. */
function haSuffixFor(toolName: string): string | undefined {
  return HA_SUFFIX_TOOLS.has(toolName) ? resolvePrompt(`ha-suffix/${toolName}`) : undefined;
}

const TODO_ITEM_TOOLS: ReadonlySet<string> = new Set([
  'HassListAddItem',
  'HassListCompleteItem',
  'HassListRemoveItem',
]);

const log = createLogger('tool-bridge');

/** The real list names HA advertises on `todo_get_items` — the only tool in the
 *  export whose list argument is documented. */
function todoListNames(tools: McpTool[]): string[] | undefined {
  const props = tools.find((t) => t.name === 'todo_get_items')?.inputSchema.properties;
  if (!isRecord(props) || !isRecord(props.todo_list)) {
    return undefined;
  }
  const names = props.todo_list.enum;
  return isStringArray(names) ? names : undefined;
}

/** HA exports the todo intents as a bare `{item, name}` — no descriptions, no
 * `required`, and no hint that `name` is the list, while the sibling
 * `todo_get_items` documents its list argument with an enum of real names. The
 * model fills that gap by guessing `todo_list` (or omitting the list), and HA
 * answers with an opaque "Received invalid slot info". Copying the enum across
 * and marking both slots required puts the constraint in the schema, where the
 * model can't misread it, instead of in prose. */
function enrichTodoSchemas(tools: McpTool[]): McpTool[] {
  const lists = todoListNames(tools);
  return tools.map((t) => {
    if (!TODO_ITEM_TOOLS.has(t.name)) {
      return t;
    }
    const props = t.inputSchema.properties;
    if (!isRecord(props) || !isRecord(props.name) || !isRecord(props.item)) {
      log.warn(
        { tool: t.name },
        'schema patch skipped: no {name, item} properties — upstream schema changed',
      );
      return t;
    }
    const { name: nameProp, item: itemProp } = props;
    const upstreamRequired = isStringArray(t.inputSchema.required) ? t.inputSchema.required : [];
    return {
      ...t,
      inputSchema: {
        ...t.inputSchema,
        properties: {
          ...props,
          item: { ...itemProp, description: 'The item summary.' },
          name: {
            ...nameProp,
            description: 'Name of the target to-do list.',
            ...(lists ? { enum: lists } : {}),
          },
        },
        // Union, not overwrite: HA may start declaring `required` itself, and
        // dropping a slot it marked mandatory would trade one silent failure
        // for another.
        required: [...new Set([...upstreamRequired, 'name', 'item'])],
      },
    };
  });
}

/** Merge per-tool prompt suffixes into the MCP descriptions and patch the
 * upstream schemas before either the Responses-API or Realtime tool adapter
 * sees them. Both code paths go through here so a rule written once applies on
 * every channel. Structural facts (required slots, allowed values) belong in
 * the schema; behavioural rules go in the suffix. */
export function prepareHaTools(tools: McpTool[]): McpTool[] {
  return enrichTodoSchemas(tools).map((t) => {
    const suffix = haSuffixFor(t.name);
    if (!suffix) {
      return t;
    }
    const base = t.description ?? '';
    return { ...t, description: base ? `${base}\n\n${suffix}` : suffix };
  });
}

export function mcpToolsToOpenAi(tools: McpTool[]): OpenAiFunctionTool[] {
  return prepareHaTools(tools).map((t) => ({
    type: 'function',
    name: t.name,
    description: t.description ?? '',
    parameters: t.inputSchema,
    strict: false,
  }));
}
