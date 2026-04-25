import type { Config } from '../config.ts';
import { BotTelegramSender } from './telegramSender.ts';
import type { TelegramSender } from './types.ts';

export function telegramFromConfig(cfg: Config): TelegramSender {
  return new BotTelegramSender({
    botToken: cfg.telegram.botToken,
    chatId: cfg.telegram.chatId,
  });
}
