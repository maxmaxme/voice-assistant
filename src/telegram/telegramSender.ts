import { Api } from 'grammy';
import telegramifyMarkdown from 'telegramify-markdown';
import type { TelegramSender } from './types.ts';

/** The slice of the grammY Api the sender actually uses. */
type SenderApi = Pick<Api, 'sendMessage' | 'raw'>;

export interface BotTelegramSenderOptions {
  botToken: string;
  chatId: string;
  /** Test injection point; production builds its own Api from the token. */
  api?: SenderApi;
}

export class BotTelegramSender implements TelegramSender {
  private readonly api: SenderApi;
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

  async sendDraft(text: string, draftId: number): Promise<void> {
    // Drafts are plain text on purpose: partial markdown would break
    // MarkdownV2 parsing mid-stream. The final send() formats normally.
    await this.api.raw.sendMessageDraft({
      chat_id: Number(this.chatId),
      draft_id: draftId,
      text,
    });
  }
}
