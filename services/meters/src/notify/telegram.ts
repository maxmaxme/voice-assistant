import type { Notifier } from './types.ts';
import type { AccountInfo } from '../storage/types.ts';

const PORTAL_LABEL: Record<string, string> = {
  tgc1: 'ТГК-1',
};

function label(portal: string): string {
  return PORTAL_LABEL[portal] ?? portal;
}

export interface TelegramNotifierOptions {
  token: string;
  chatId: string;
  fetch?: typeof fetch;
}

export class TelegramNotifier implements Notifier {
  private readonly token: string;
  private readonly chatId: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: TelegramNotifierOptions) {
    this.token = opts.token;
    this.chatId = opts.chatId;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async success(input: {
    portal: string;
    period: string;
    meterCount: number;
    info: AccountInfo | null;
  }): Promise<void> {
    const lines = [
      `✓ ${label(input.portal)} за ${input.period}: показания поданы (${input.meterCount} счётчика).`,
    ];
    if (input.info) {
      lines.push(`💰 ЛС ${input.info.accountId}: ${input.info.balanceText}`);
    }
    await this.send(lines.join('\n'));
  }

  async failure(input: {
    portal: string;
    period: string;
    attempt: number;
    maxAttempts: number;
    error: string;
    screenshotPath: string | null;
  }): Promise<void> {
    const lines = [
      `✗ ${label(input.portal)} за ${input.period} — попытка ${input.attempt}/${input.maxAttempts}: ${input.error}`,
    ];
    if (input.screenshotPath) {
      lines.push(`Скриншот: ${input.screenshotPath}`);
    }
    lines.push('Повтор завтра.');
    await this.send(lines.join('\n'));
  }

  async windowClosed(input: { portal: string; period: string }): Promise<void> {
    await this.send(
      `⚠ Окно подачи показаний закрыто. Не подано: ${label(input.portal)} за ${input.period}.\n` +
        `Подайте, пожалуйста, вручную.`,
    );
  }

  private async send(text: string): Promise<void> {
    const url = `https://api.telegram.org/bot${this.token}/sendMessage`;
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: this.chatId, text }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '<no body>');
      throw new Error(`Telegram sendMessage failed: ${res.status} ${body}`);
    }
  }
}
