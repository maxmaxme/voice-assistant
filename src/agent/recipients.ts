import type { IdentitiesAdapter } from '../memory/types.ts';

/** "Valid recipients (user id = name): …" — appended to recipient-resolution
 *  errors so the model can re-ask with a concrete id instead of guessing. */
export function recipientsHint(identities: IdentitiesAdapter): string {
  const users = identities.listTelegramUsers();
  if (users.length === 0) {
    return 'No users have a Telegram chat linked.';
  }
  return (
    'Valid recipients (user id = name): ' +
    users.map((u) => `${u.userId}=${u.name}`).join(', ') +
    '.'
  );
}

/** Tool-specific phrasing for the three recipient-resolution failures. Each
 *  caller keeps its historical wording (tests assert on the exact text); the
 *  recipients hint is appended automatically where it applies. */
export interface RecipientErrorMessages {
  /** `recipient` arg present but not an integer user id. */
  invalidRecipient: string;
  /** No `recipient` arg and no current user (unscoped caller). Hint appended. */
  noCurrentUser: string;
  /** Resolved user has no Telegram chat to deliver to. Hint appended. */
  noTelegramLinked: (userId: number) => string;
}

/** Resolve a tool's optional `recipient` argument to a Telegram-deliverable
 *  user id: the explicit integer arg, or the current user when omitted. Throws
 *  (with the caller's phrasing) when the arg is malformed, there is no current
 *  user to default to, or the resolved user has no Telegram chat linked. */
export function resolveTelegramRecipient(
  recipientArg: unknown,
  currentUserId: number | null,
  identities: IdentitiesAdapter,
  messages: RecipientErrorMessages,
): number {
  let targetUserId: number | null;
  if (recipientArg === undefined || recipientArg === null) {
    targetUserId = currentUserId;
  } else if (typeof recipientArg === 'number' && Number.isInteger(recipientArg)) {
    targetUserId = recipientArg;
  } else {
    throw new Error(messages.invalidRecipient);
  }
  if (targetUserId === null) {
    throw new Error(`${messages.noCurrentUser} ${recipientsHint(identities)}`);
  }
  if (identities.identityFor('telegram', targetUserId) === null) {
    throw new Error(`${messages.noTelegramLinked(targetUserId)} ${recipientsHint(identities)}`);
  }
  return targetUserId;
}
