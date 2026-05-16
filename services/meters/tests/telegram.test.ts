import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TelegramNotifier } from '../src/notify/telegram.ts';

interface TelegramCallBody {
  chat_id: string;
  text: string;
  [key: string]: unknown;
}

interface Call {
  url: string;
  body: TelegramCallBody | null;
}

let calls: Call[];
let mockFetch: typeof fetch;

function extractCallBody(call: Call): TelegramCallBody | null {
  return call.body;
}

beforeEach(() => {
  calls = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fn: any = vi.fn(async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : String(input);
    let body: TelegramCallBody | null = null;
    if (init?.body) {
      const parsed = JSON.parse(init.body);
      if (parsed && typeof parsed === 'object') {
        body = parsed;
      }
    }
    calls.push({ url, body });
    return new Response('{"ok":true}', { status: 200 });
  });
  mockFetch = fn;
});

describe('TelegramNotifier.success', () => {
  it('posts a formatted message with balance line', async () => {
    const n = new TelegramNotifier({
      token: 'T',
      chatId: '42',
      fetch: mockFetch,
    });

    await n.success({
      portal: 'tgc1',
      period: '2026-05',
      meterCount: 2,
      info: { accountId: 'ACC', balanceText: 'переплата 1 руб' },
      alreadySubmitted: false,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.telegram.org/botT/sendMessage');
    const body = extractCallBody(calls[0]);
    expect(body?.chat_id).toBe('42');
    expect(String(body?.text)).toContain('✓ ТГК-1 за 2026-05');
    expect(String(body?.text)).toContain('показания поданы');
    expect(String(body?.text)).toContain('2 шт');
    expect(String(body?.text)).toContain('ЛС ACC: переплата 1 руб');
  });

  it('uses "уже были поданы ранее" wording when alreadySubmitted=true', async () => {
    const n = new TelegramNotifier({
      token: 'T',
      chatId: '42',
      fetch: mockFetch,
    });

    await n.success({
      portal: 'tgc1',
      period: '2026-05',
      meterCount: 2,
      info: { accountId: 'ACC', balanceText: 'переплата 1 руб' },
      alreadySubmitted: true,
    });

    const body = extractCallBody(calls[0]);
    expect(String(body?.text)).toContain('уже были поданы ранее');
    expect(String(body?.text)).not.toContain('показания поданы (');
  });

  it('omits balance line when info is null', async () => {
    const n = new TelegramNotifier({
      token: 'T',
      chatId: '42',
      fetch: mockFetch,
    });

    await n.success({
      portal: 'tgc1',
      period: '2026-05',
      meterCount: 2,
      info: null,
      alreadySubmitted: false,
    });
    const body = extractCallBody(calls[0]);
    expect(String(body?.text)).not.toMatch(/ЛС/);
  });
});

describe('TelegramNotifier.failure', () => {
  it('mentions attempt/maxAttempts and the error', async () => {
    const n = new TelegramNotifier({
      token: 'T',
      chatId: '42',
      fetch: mockFetch,
    });

    await n.failure({
      portal: 'tgc1',
      period: '2026-05',
      attempt: 3,
      maxAttempts: 5,
      error: 'HTTP 400: Validation Failed',
    });

    const body = extractCallBody(calls[0]);
    expect(String(body?.text)).toContain('✗ ТГК-1 за 2026-05');
    expect(String(body?.text)).toContain('попытка 3/5');
    expect(String(body?.text)).toContain('HTTP 400: Validation Failed');
    expect(String(body?.text)).toContain('Повтор завтра');
  });
});

describe('TelegramNotifier.windowClosed', () => {
  it('emits the "submit manually" message', async () => {
    const n = new TelegramNotifier({
      token: 'T',
      chatId: '42',
      fetch: mockFetch,
    });

    await n.windowClosed({ portal: 'tgc1', period: '2026-05' });
    const body = extractCallBody(calls[0]);
    expect(String(body?.text)).toContain('⚠');
    expect(String(body?.text)).toContain('ТГК-1');
    expect(String(body?.text)).toContain('вручную');
  });
});
