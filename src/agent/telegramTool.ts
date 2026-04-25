import type { TelegramSender } from '../telegram/types.ts';
import type { OpenAiFunctionTool } from './toolBridge.ts';

export const TELEGRAM_TOOL_NAME = 'send_to_telegram';

export function buildTelegramTool(): OpenAiFunctionTool {
  return {
    type: 'function',
    name: TELEGRAM_TOOL_NAME,
    description:
      'Send a text message to the user in Telegram from the assistant bot. ' +
      'Use when the user asks to send/forward something to Telegram (e.g. ' +
      '"отправь это в телеграм", "пришли мне в телеграм", "скинь список в телеграм"). ' +
      'Pass the full message body as `text` — include the actual content to deliver, ' +
      'not just a confirmation. Plain text only (no Markdown).',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'The message body to deliver to the user in Telegram.',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
  };
}

export async function executeTelegramTool(
  telegram: TelegramSender,
  args: Record<string, unknown>,
): Promise<{ ok: true }> {
  const text = typeof args.text === 'string' ? args.text : '';
  if (!text.trim()) throw new Error('send_to_telegram: `text` is required');
  await telegram.send(text);
  return { ok: true };
}
