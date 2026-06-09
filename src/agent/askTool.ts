import type { OpenAiFunctionTool } from './toolBridge.ts';

/**
 * Local "ask" tool. Calling it ends the agent turn and signals the
 * orchestrator that the assistant needs an immediate verbal answer
 * from the user (so capture should reopen without another wake word).
 *
 * Routing: handled in OpenAiAgent.respond() — when the LLM requests
 * this tool, we return its `text` argument as the AgentResponse text
 * with expectsFollowUp=true and stop the tool loop.
 */
export const ASK_TOOL_NAME = 'ask';

export function buildAskTool(): OpenAiFunctionTool {
  return {
    type: 'function',
    name: ASK_TOOL_NAME,
    description:
      'Use this whenever your reply ends with a question and you expect ' +
      'the user to answer by voice. Pass the question as `text`. Calling ' +
      '`ask` keeps the microphone open so the user can reply immediately; ' +
      'putting a question in your plain reply text closes the mic and forces ' +
      'them to say the wake word again. ' +
      'This applies to BOTH cases: (a) clarifying questions you need ' +
      'answered before you can act, AND (b) any other question — including ' +
      'ones the user explicitly invited (e.g. "ask me something", ' +
      '"quiz me", small talk). If the turn ends in a `?` aimed at the user, ' +
      'it belongs in `ask`, not in the reply text. ' +
      'IMPORTANT: call `ask` ALONE — do not emit it in parallel with other ' +
      'tool calls in the same turn. If you need to remember a fact and then ' +
      'ask a question, do the remember first, wait for its result, and only ' +
      'then call `ask` on a subsequent turn.',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description:
            'The exact question to speak out loud. One short sentence. ' +
            "In the user's language.",
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
  };
}
