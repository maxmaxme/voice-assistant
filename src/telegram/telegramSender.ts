import { Api } from 'grammy';
import telegramifyMarkdown from 'telegramify-markdown';
import type { TelegramSender } from './types.ts';

export interface BotTelegramSenderOptions {
  botToken: string;
  chatId: string;
  /** Test injection point; production builds its own Api from the token. */
  api?: Api;
}

export class BotTelegramSender implements TelegramSender {
  private readonly api: Api;
  private readonly chatId: string;

  constructor(opts: BotTelegramSenderOptions) {
    this.api = opts.api ?? new Api(opts.botToken);
    this.chatId = opts.chatId;
  }

  async send(text: string): Promise<void> {
    const formatted = telegramifyMarkdown(text, 'escape');
    await this.api.sendMessage(this.chatId, formatted, {
      parse_mode: 'MarkdownV2',
    });
  }
}
