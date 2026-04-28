import { Telegraf } from 'telegraf';
import telegramifyMarkdown from 'telegramify-markdown';
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
    const formatted = telegramifyMarkdown(text, 'escape');
    await this.bot.telegram.sendMessage(this.chatId, formatted, {
      parse_mode: 'MarkdownV2',
    });
  }
}
