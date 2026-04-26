import { Telegraf } from 'telegraf';
import type { TelegramSender } from './types.ts';

export interface BotTelegramSenderOptions {
  botToken: string;
  chatId: string;
}

export class BotTelegramSender implements TelegramSender {
  private readonly bot: Telegraf;
  private readonly chatId: string;

  constructor(opts: BotTelegramSenderOptions) {
    this.bot = new Telegraf(opts.botToken);
    this.chatId = opts.chatId;
  }

  async send(text: string): Promise<void> {
    await this.bot.telegram.sendMessage(this.chatId, text);
  }
}
