import { createLogger } from '../utils/logger.ts';

const log = createLogger('telegram-draft');

export interface DraftSink {
  sendDraft(text: string, draftId: number): Promise<void>;
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
  private buffer = '';
  private timer: NodeJS.Timeout | null = null;
  private lastSentAt = 0;
  private finished = false;
  private inflight: Promise<void> | null = null;

  constructor(sink: DraftSink, draftId: number, intervalMs = 1000) {
    this.sink = sink;
    this.draftId = draftId;
    this.intervalMs = intervalMs;
  }

  /** Show the "Thinking…" placeholder (empty draft) immediately. */
  start(): void {
    this.schedule();
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
    const send = (async () => {
      try {
        // Telegram caps message text at 4096 chars after entity parsing.
        await this.sink.sendDraft(this.buffer.slice(0, 4096), this.draftId);
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
