import type { Config } from '../config.ts';
import { BotTelegramSender } from './telegramSender.ts';
import { TelegrafReceiver } from './telegrafReceiver.ts';
import type { TelegramSender, TelegramReceiver } from './types.ts';

export function telegramFromConfig(cfg: Config): TelegramSender {
  return new BotTelegramSender({
    botToken: cfg.telegram.botToken,
    chatId: cfg.telegram.chatId,
  });
}

export function receiverFromConfig(cfg: Config): TelegramReceiver {
  return new TelegrafReceiver({ botToken: cfg.telegram.botToken });
}
