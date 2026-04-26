import { z } from 'zod';
import { zodTextFormat } from 'openai/helpers/zod.js';

/** Voice channel: speak can be null for silent device confirmations. */
export const VoiceAgentOutputSchema = z.object({
  speak: z
    .string()
    .nullable()
    .describe(
      'Text to say aloud. Set to null for a silent device action confirmation — ' +
        'the user hears a chime instead.',
    ),
  direction: z
    .enum(['on', 'off', 'neutral'])
    .nullable()
    .describe(
      'Audio chime direction when speak is null. ' +
        '"on" = ascending (device turned on/opened/activated). ' +
        '"off" = descending (device turned off/closed/deactivated). ' +
        '"neutral" = single tone (scene applied, value set). ' +
        'Must be null whenever speak contains text.',
    ),
});

/** Chat/Telegram channel: speak is always required text, no audio feedback. */
export const ChatAgentOutputSchema = z.object({
  speak: z.string().describe('Your response text.'),
});

export type VoiceAgentOutput = z.infer<typeof VoiceAgentOutputSchema>;
export type ChatAgentOutput = z.infer<typeof ChatAgentOutputSchema>;
export type ActionDirection = 'on' | 'off' | 'neutral';

export const VOICE_TEXT_FORMAT = zodTextFormat(VoiceAgentOutputSchema, 'agent_output');
export const CHAT_TEXT_FORMAT = zodTextFormat(ChatAgentOutputSchema, 'agent_output');
