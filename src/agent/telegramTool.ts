import type { Scope } from '../memory/scope.ts';
import type { IdentitiesAdapter } from '../memory/types.ts';
import type { TelegramSender } from '../telegram/types.ts';
import { resolveTelegramRecipient } from './recipients.ts';
import type { OpenAiFunctionTool } from './toolBridge.ts';

export const TELEGRAM_TOOL_NAME = 'send_to_telegram';

/** Everything `send_to_telegram` needs to resolve a recipient to a chat and
 *  deliver. `scope` is the current principal (null when unscoped); recipients
 *  are resolved to a Telegram chat via `identities`; `senderFor` builds a
 *  sender bound to a specific chat id. */
export interface TelegramToolContext {
  scope: Scope | null;
  identities: IdentitiesAdapter;
  senderFor: (chatId: string) => TelegramSender;
}

export function buildTelegramTool(): OpenAiFunctionTool {
  return {
    type: 'function',
    name: TELEGRAM_TOOL_NAME,
    description:
      'Send a text message to a user in Telegram from the assistant bot. ' +
      'Use when the user asks to send/forward something to Telegram (e.g. ' +
      '"send this to Telegram", "forward this to me", "post the list to Telegram"). ' +
      'Pass the full message body as `text` — the actual content to deliver, not a confirmation. Plain text only. ' +
      "`recipient` is the target user's id; OMIT it to send to the current user (yourself). " +
      'If the current user has no Telegram linked (e.g. on the shared speaker), the call fails with an error ' +
      'listing the valid recipients (id = name) — ask the user who to send to, then pass that id as `recipient`.',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'The message body to deliver.',
        },
        recipient: {
          type: 'integer',
          description:
            "Recipient user id. Omit to send to the current user. Use an id from the error's recipient list to send to someone else.",
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
  };
}

export async function executeTelegramTool(
  ctx: TelegramToolContext,
  args: Record<string, unknown>,
): Promise<{ ok: true; recipientUserId: number }> {
  const text = typeof args.text === 'string' ? args.text : '';
  if (!text.trim()) {
    throw new Error('send_to_telegram: `text` is required');
  }

  const targetUserId = resolveTelegramRecipient(
    args.recipient,
    ctx.scope?.userId ?? null,
    ctx.identities,
    {
      invalidRecipient:
        'send_to_telegram: `recipient` must be a user id (integer), or omit it to send to yourself',
      noCurrentUser:
        'send_to_telegram: no recipient — there is no current user to send to, specify one.',
      noTelegramLinked: (userId) =>
        `send_to_telegram: user ${userId} has no Telegram linked — cannot deliver.`,
    },
  );

  // resolveTelegramRecipient already verified the identity exists.
  const chatId = ctx.identities.identityFor('telegram', targetUserId)!;
  await ctx.senderFor(chatId).send(text);
  return { ok: true, recipientUserId: targetUserId };
}
