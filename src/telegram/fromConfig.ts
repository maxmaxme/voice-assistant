import type { Config } from '../config.ts';
import { GrammyReceiver } from './grammyReceiver.ts';
import type { TelegramReceiver } from './types.ts';

export function receiverFromConfig(cfg: Config): TelegramReceiver {
  return new GrammyReceiver({ botToken: cfg.telegram.botToken });
}
