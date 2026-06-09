import { createLogger } from '../utils/logger.ts';

const log = createLogger('telegram-draft');

export interface DraftSink {
  sendDraft(text: string, draftId: number): Promise<void>;
}

/** Shown while the agent hasn't streamed any reply text yet (tool calls in
 *  progress). An explicit text rather than the Bot API's empty-text
 *  "Thinking…" placeholder — not every client renders the latter. */
export const DRAFT_PLACEHOLDER = '🤔 Думаю…';

export interface DraftStreamerOptions {
  /** Minimum gap between sendMessageDraft calls. Default 1000ms. */
  intervalMs?: number;
  /** Placeholder shown before the first delta. Default DRAFT_PLACEHOLDER. */
  placeholder?: string;
  /** How often to re-send the placeholder while no deltas have arrived —
   *  drafts are ephemeral ~30-second previews, so a long tool loop would
   *  otherwise let the indicator expire. Default 20s. */
  keepaliveMs?: number;
}

/** Pushes accumulated reply text into a Telegram message draft
 *  (sendMessageDraft), throttled to one API call per interval. Drafts are
 *  ephemeral 30-second previews — the caller still sends the final message
 *  via the regular sender. All draft sends are best-effort: a failure must
 *  never break the reply path. */
export class DraftStreamer {
  private readonly sink: DraftSink;
  private readonly draftId: number;
  private readonly intervalMs: number;
  private readonly placeholder: string;
  private readonly keepaliveMs: number;
  private buffer = '';
  private timer: NodeJS.Timeout | null = null;
  private keepalive: NodeJS.Timeout | null = null;
  private lastSentAt = 0;
  private finished = false;
  private inflight: Promise<void> | null = null;

  constructor(sink: DraftSink, draftId: number, opts: DraftStreamerOptions = {}) {
    this.sink = sink;
    this.draftId = draftId;
    this.intervalMs = opts.intervalMs ?? 1000;
    this.placeholder = opts.placeholder ?? DRAFT_PLACEHOLDER;
    this.keepaliveMs = opts.keepaliveMs ?? 20_000;
  }

  /** Show the placeholder immediately and keep it alive until deltas flow. */
  start(): void {
    this.schedule();
    this.keepalive = setInterval(() => {
      // Re-send the placeholder directly: the throttle window (~1s) is long
      // gone by keepalive time, and flush() itself guards against overlap.
      if (this.buffer === '') {
        void this.flush();
      }
    }, this.keepaliveMs);
  }

  onDelta(delta: string): void {
    if (this.finished) {
      return;
    }
    this.buffer += delta;
    this.schedule();
  }

  /** Stop all future draft sends; the final message supersedes the draft.
   *  Resolves once any in-flight send has settled, so the caller can make
   *  sure no slow draft lands after the final persisted message. */
  finish(): Promise<void> {
    this.finished = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.keepalive) {
      clearInterval(this.keepalive);
      this.keepalive = null;
    }
    return this.inflight ?? Promise.resolve();
  }

  private schedule(): void {
    if (this.timer || this.finished) {
      return;
    }
    const wait = Math.max(0, this.lastSentAt + this.intervalMs - Date.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, wait);
  }

  private async flush(): Promise<void> {
    if (this.finished) {
      return;
    }
    if (this.inflight) {
      // A previous send is still in flight. Concurrent sendMessageDraft calls
      // can resolve out of order (an older, shorter draft overwriting a newer
      // one), so skip this flush and reschedule once the in-flight send
      // settles — the rescheduled flush picks up the latest buffer.
      await this.inflight;
      this.schedule();
      return;
    }
    this.lastSentAt = Date.now();
    // Telegram caps message text at 4096 chars after entity parsing.
    const text = this.buffer === '' ? this.placeholder : this.buffer.slice(0, 4096);
    const send = (async () => {
      try {
        await this.sink.sendDraft(text, this.draftId);
      } catch (err) {
        log.debug({ err }, 'sendMessageDraft failed (best-effort, ignoring)');
      }
    })();
    this.inflight = send;
    await send;
    if (this.inflight === send) {
      this.inflight = null;
    }
  }
}
