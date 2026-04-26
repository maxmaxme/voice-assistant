import { z } from 'zod';
import { zodTextFormat } from 'openai/helpers/zod.js';

export const AgentOutputSchema = z.object({
  speak: z
    .string()
    .nullable()
    .describe(
      'Text to say aloud to the user. Set to null only for a silent device action confirmation ' +
        '(voice channel only) — the user will hear a chime instead.',
    ),
  direction: z
    .enum(['on', 'off', 'neutral'])
    .nullable()
    .describe(
      'Direction of the audio chime played when speak is null. ' +
        '"on" = ascending tone (device turned on, opened, or activated). ' +
        '"off" = descending tone (device turned off, closed, or deactivated). ' +
        '"neutral" = single tone (scene applied, value set, or direction unclear). ' +
        'Must be null whenever speak contains text.',
    ),
});

export type AgentOutput = z.infer<typeof AgentOutputSchema>;
export type ActionDirection = 'on' | 'off' | 'neutral';

/** Passed directly to `text.format` in responses.create / responses.parse. */
export const AGENT_TEXT_FORMAT = zodTextFormat(AgentOutputSchema, 'agent_output');

/** Parse a JSON string from the LLM into AgentOutput, with a plain-text fallback. */
export function parseAgentOutput(raw: string): AgentOutput {
  try {
    return AgentOutputSchema.parse(JSON.parse(raw));
  } catch {
    return { speak: raw.trim() || null, direction: null };
  }
}
