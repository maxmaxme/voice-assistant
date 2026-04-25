import type { TelegramSender } from './types.ts';

export interface BotTelegramSenderOptions {
  botToken: string;
  chatId: string;
  fetchImpl?: typeof fetch;
}

export class BotTelegramSender implements TelegramSender {
  private readonly botToken: string;
  private readonly chatId: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: BotTelegramSenderOptions) {
    this.botToken = opts.botToken;
    this.chatId = opts.chatId;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async send(text: string): Promise<void> {
    const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: this.chatId, text, disable_web_page_preview: true }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Telegram sendMessage failed: ${res.status} ${res.statusText} ${body}`);
    }
  }
}
