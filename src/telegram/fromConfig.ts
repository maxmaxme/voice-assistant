import { GrammyReceiver } from './grammyReceiver.ts';
import type { TelegramReceiver } from './types.ts';

export function receiverFromToken(botToken: string): TelegramReceiver {
  return new GrammyReceiver({ botToken });
}
