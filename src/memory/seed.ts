import { hashToken } from './identities.ts';
import type { IdentitiesAdapter } from './types.ts';

export interface SeedInput {
  allowedChatIds: number[];
  httpApiKeys: string[];
  voiceToken: string;
}

/** One-time import of the pre-DB env allow-lists. No-op once any identity
 *  exists, so it never clobbers DB-managed users on later boots. */
export function seedIdentitiesFromConfig(identities: IdentitiesAdapter, input: SeedInput): void {
  if (!identities.isEmpty()) {
    return;
  }
  // The single shared principal — the speaker(s).
  const home = identities.addUser('home', 'shared');
  if (input.voiceToken) {
    identities.attachIdentity('voice', hashToken(input.voiceToken), home);
  }
  // Each Telegram chat → its own member user.
  for (const chatId of input.allowedChatIds) {
    const u = identities.addUser(`tg:${chatId}`, 'member');
    identities.attachIdentity('telegram', String(chatId), u);
  }
  // Each HTTP key → its own member user.
  for (let i = 0; i < input.httpApiKeys.length; i++) {
    const u = identities.addUser(`http:${i + 1}`, 'member');
    identities.attachIdentity('http', hashToken(input.httpApiKeys[i]), u);
  }
}
