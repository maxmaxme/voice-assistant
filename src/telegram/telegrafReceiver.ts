import { Telegraf, type Context } from 'telegraf';
import type { TelegramReceiver, TelegramMessage } from './types.ts';

export interface TelegrafReceiverOptions {
  botToken: string;
  /** Called after stop() finishes. Use for closing resources tied to the store. */
  onStop?: () => void;
}

export class TelegrafReceiver implements TelegramReceiver {
  private readonly bot: Telegraf;
  private readonly onStop: (() => void) | undefined;
  private readonly pending: TelegramMessage[] = [];
  private readonly resolvers: Array<(value: TelegramMessage | null) => void> = [];
  private stopped = false;
  /** Track media_group_ids we've already replied to with a "rejected" message,
   * so subsequent updates from the same album are silently dropped. */
  private readonly seenAlbumGroups = new Set<string>();

  constructor(opts: TelegrafReceiverOptions) {
    this.bot = new Telegraf(opts.botToken);
    this.onStop = opts.onStop;

    // Capture all incoming message updates and push them into the queue.
    this.bot.on('message', (ctx: Context) => {
      const msg = this.classify(ctx);
      if (msg) {
        this.enqueue(msg);
      }
    });
  }

  private enqueue(msg: TelegramMessage): void {
    if (this.resolvers.length > 0) {
      // A consumer is already waiting — hand the message directly.
      this.resolvers.shift()!(msg);
    } else {
      this.pending.push(msg);
    }
  }

  private dequeue(): Promise<TelegramMessage | null> {
    if (this.pending.length > 0) {
      return Promise.resolve(this.pending.shift()!);
    }
    return new Promise<TelegramMessage | null>((resolve) => {
      this.resolvers.push(resolve);
    });
  }

  async *messages(): AsyncIterable<TelegramMessage> {
    // launch() starts long-polling. It returns a promise that resolves when
    // the bot is stopped. We don't await it here so the iterator can run.
    this.bot.launch({ dropPendingUpdates: false }).catch(() => {
      // Errors during graceful stop are expected — swallow them.
    });

    while (!this.stopped) {
      const msg = await this.dequeue();
      if (msg === null || this.stopped) {
        return;
      }
      yield msg;
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.bot.stop();
    // Wake any dequeue() calls that are waiting so they can exit.
    for (const resolve of this.resolvers) {
      resolve(null);
    }
    this.resolvers.length = 0;
    this.onStop?.();
  }

  private classify(ctx: Context): TelegramMessage | null {
    const update = ctx.update;
    if (!('message' in update) || !update.message) {
      return null;
    }
    const m = update.message;

    // Must have a human sender (not an anonymous channel post, etc.).
    if (!('from' in m) || !m.from) {
      return null;
    }

    const base = {
      updateId: update.update_id,
      chatId: m.chat.id,
      fromUserId: m.from.id,
      receivedAt: ('date' in m ? (m.date as number) : 0) * 1000,
    };

    if ('text' in m && typeof m.text === 'string') {
      return { ...base, kind: 'text', text: m.text };
    }
    if ('voice' in m && m.voice) {
      return {
        ...base,
        kind: 'voice',
        fileId: m.voice.file_id,
        durationSec: m.voice.duration,
      };
    }
    if ('photo' in m && Array.isArray(m.photo) && m.photo.length > 0) {
      const groupId =
        'media_group_id' in m && typeof m.media_group_id === 'string' ? m.media_group_id : null;
      if (groupId) {
        if (this.seenAlbumGroups.has(groupId)) {
          return null;
        }
        this.seenAlbumGroups.add(groupId);
        return { ...base, kind: 'photo-album-rejected' };
      }
      // Largest size is last in Telegram's photo array.
      const largest = m.photo[m.photo.length - 1] satisfies { file_id: string };
      const caption = 'caption' in m && typeof m.caption === 'string' ? m.caption : undefined;
      return { ...base, kind: 'photo', fileId: largest.file_id, caption };
    }
    return { ...base, kind: 'unsupported', reason: 'unhandled message type' };
  }
}
