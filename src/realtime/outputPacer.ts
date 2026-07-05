import { REALTIME_BYTES_PER_SEC } from './audio/format.ts';

/**
 * Re-clocks the OpenAI reply audio to the device.
 *
 * OpenAI streams a reply far faster than real time (measured ~8×: a 2.9 s
 * reply arrives in ~360 ms across a few large deltas). Forwarding each delta
 * to the device the instant it lands dumps the whole reply as one burst,
 * which the device playback chain can't absorb → hiss. When paceMs > 0 we
 * instead buffer the PCM and meter it out in fixed paceMs frames on a timer,
 * re-clocking the burst to ~real time (what pipecat does on the reference
 * stack). The device's 150 ms prebuffer absorbs the residual timer jitter.
 * paceMs = 0 disables pacing (legacy behaviour — each chunk forwarded
 * verbatim).
 */
export class OutputPacer {
  private readonly paceMs: number;
  private readonly send: (frame: Buffer) => void;
  // Pending PCM16 @ 24 kHz not yet sent to the device. Grows as deltas arrive,
  // drains one frame per timer tick. Only used when paceMs > 0.
  private paceBuf: Buffer = Buffer.alloc(0);
  private paceTimer: NodeJS.Timeout | null = null;
  // Control actions that must reach the device AFTER the buffered audio (the
  // end-of-reply phase=idle / follow_up). Run when paceBuf drains — otherwise
  // the device would see "reply over" while seconds of audio are still queued
  // here and close the turn / open the follow-up mic too early.
  private afterDrainActions: Array<() => void> = [];

  constructor(paceMs: number, send: (frame: Buffer) => void) {
    this.paceMs = paceMs;
    this.send = send;
  }

  /** Send one PCM16 @ 24 kHz chunk to the device. With pacing off, forward it
   * verbatim (legacy burst). With pacing on, buffer it and let the timer meter
   * it out in paceMs frames. */
  enqueue(pcm: Buffer): void {
    if (this.paceMs <= 0) {
      this.send(pcm);
      return;
    }
    this.paceBuf = this.paceBuf.length === 0 ? pcm : Buffer.concat([this.paceBuf, pcm]);
    if (this.paceTimer === null) {
      const t = setInterval(() => this.drainPace_(), this.paceMs);
      t.unref?.();
      this.paceTimer = t;
    }
  }

  /** Run `fn` once the paced audio queue has fully drained to the device — or
   * immediately when pacing is off / the queue is already empty. Used for the
   * end-of-reply control messages (idle phase, follow_up) that must reach the
   * device AFTER its audio, not while frames are still queued here. */
  afterDrain(fn: () => void): void {
    if (this.paceMs <= 0 || this.paceBuf.length === 0) {
      fn();
      return;
    }
    this.afterDrainActions.push(fn);
  }

  /** Drop all buffered audio + deferred end-of-reply actions and stop the
   * pacer. Called when the reply is cancelled (barge-in / interrupt) or the
   * session / device goes away — the queued tail is no longer wanted. */
  flush(): void {
    this.paceBuf = Buffer.alloc(0);
    this.afterDrainActions = [];
    this.stopPaceTimer_();
  }

  /** Pacer tick: emit one paced frame; when the queue empties, stop the timer
   * and run any deferred end-of-reply actions. */
  private drainPace_(): void {
    if (this.paceBuf.length === 0) {
      this.stopPaceTimer_();
      const actions = this.afterDrainActions;
      this.afterDrainActions = [];
      for (const fn of actions) {
        fn();
      }
      return;
    }
    // Even byte count so a PCM16 sample is never split across frames.
    const frameBytes = Math.max(
      2,
      Math.floor((REALTIME_BYTES_PER_SEC * this.paceMs) / 1000 / 2) * 2,
    );
    const n = Math.min(frameBytes, this.paceBuf.length);
    this.send(this.paceBuf.subarray(0, n));
    this.paceBuf = this.paceBuf.subarray(n);
  }

  private stopPaceTimer_(): void {
    if (this.paceTimer !== null) {
      clearInterval(this.paceTimer);
      this.paceTimer = null;
    }
  }
}
