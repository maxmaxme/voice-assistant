import { z } from 'zod';
import { zodTextFormat } from 'openai/helpers/zod.js';

/** The agent's final reply: a single string to show or speak to the user. */
export const AgentOutputSchema = z.object({
  speak: z.string().describe('Your response text.'),
});

export type AgentOutput = z.infer<typeof AgentOutputSchema>;

export const AGENT_TEXT_FORMAT = zodTextFormat(AgentOutputSchema, 'agent_output');
