import type { Config } from '../config.ts';
import { TelegrafReceiver } from './telegrafReceiver.ts';
import type { TelegramReceiver } from './types.ts';

export function receiverFromConfig(cfg: Config): TelegramReceiver {
  return new TelegrafReceiver({ botToken: cfg.telegram.botToken });
}
