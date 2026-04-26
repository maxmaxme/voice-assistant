import type { TelegramReceiver, TelegramMessage } from './types.ts';
import type { OffsetStore } from './offsetStore.ts';

export interface PollingTelegramReceiverOptions {
  botToken: string;
  offsetStore: OffsetStore;
  fetchImpl?: typeof fetch;
  /** getUpdates long-poll timeout, seconds. Default 30. Use 0 in tests. */
  pollTimeoutSec?: number;
  /** Backoff between failed polls. Default 2000 ms. */
  retryDelayMs?: number;
  /** Called after stop() finishes. Use for closing resources tied to the store. */
  onStop?: () => void;
}

interface RawUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: { id: number };
    chat: { id: number };
    date: number;
    text?: string;
    voice?: { file_id: string; duration: number };
  };
}

export class PollingTelegramReceiver implements TelegramReceiver {
  private readonly botToken: string;
  private readonly store: OffsetStore;
  private readonly fetchImpl: typeof fetch;
  private readonly pollTimeoutSec: number;
  private readonly retryDelayMs: number;
  private readonly onStop: (() => void) | undefined;
  private stopped = false;
  private currentAbort: AbortController | null = null;

  constructor(opts: PollingTelegramReceiverOptions) {
    this.botToken = opts.botToken;
    this.store = opts.offsetStore;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.pollTimeoutSec = opts.pollTimeoutSec ?? 30;
    this.retryDelayMs = opts.retryDelayMs ?? 2000;
    this.onStop = opts.onStop;
  }

  async *messages(): AsyncIterable<TelegramMessage> {
    while (!this.stopped) {
      let updates: RawUpdate[] | null;
      try {
        updates = await this.poll();
      } catch (err) {
        if (this.stopped) return;
        process.stderr.write(`[telegram] poll error: ${(err as Error).message}\n`);
        await this.sleep(this.retryDelayMs);
        continue;
      }
      if (this.stopped) return;
      if (updates === null) {
        // ok:false response — backoff and retry
        await this.sleep(this.retryDelayMs);
        continue;
      }

      for (const u of updates) {
        // Advance offset before yielding so the position is persisted even if
        // the consumer never resumes the iterator (e.g. after stop()).
        this.store.write(u.update_id + 1);
        const msg = this.classify(u);
        if (msg) yield msg;
      }

      // If no messages were yielded (empty poll), yield control to the event loop
      // so stop() can take effect without spinning.
      if (updates.length === 0 && !this.stopped) {
        await this.sleep(0);
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.currentAbort?.abort();
    this.onStop?.();
  }

  private async poll(): Promise<RawUpdate[] | null> {
    // store holds the next-offset-to-fetch (last_seen + 1). Telegram returns
    // updates with id >= offset; passing offset=0 on a fresh store yields
    // any backlog the bot has, which is what we want.
    const offset = this.store.read();
    const params = new URLSearchParams({
      offset: String(offset),
      timeout: String(this.pollTimeoutSec),
      allowed_updates: JSON.stringify(['message']),
    });
    const url = `https://api.telegram.org/bot${this.botToken}/getUpdates?${params}`;
    this.currentAbort = new AbortController();
    const res = await this.fetchImpl(url, { signal: this.currentAbort.signal });
    const json = (await res.json()) as { ok: boolean; result?: RawUpdate[]; description?: string };
    if (!json.ok) {
      process.stderr.write(`[telegram] getUpdates ok=false: ${json.description ?? 'unknown'}\n`);
      return null;
    }
    return json.result ?? [];
  }

  private classify(u: RawUpdate): TelegramMessage | null {
    const m = u.message;
    if (!m || !m.from) return null;
    const base = {
      updateId: u.update_id,
      chatId: m.chat.id,
      fromUserId: m.from.id,
      receivedAt: m.date * 1000,
    };
    if (m.text !== undefined) return { ...base, kind: 'text', text: m.text };
    if (m.voice)
      return { ...base, kind: 'voice', fileId: m.voice.file_id, durationSec: m.voice.duration };
    return { ...base, kind: 'unsupported', reason: 'unhandled message type' };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((res) => setTimeout(res, ms));
  }
}
