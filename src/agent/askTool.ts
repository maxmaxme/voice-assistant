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
      'Use this when you need the user to answer a clarifying question ' +
      'before you can act. Pass the question as `text`. The user will ' +
      'hear it and respond by voice; treat their next utterance as the ' +
      'answer. Prefer this over making up an excuse like "please clarify" ' +
      'or wrapping a question in plain text.',
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
