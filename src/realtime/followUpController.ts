import { createLogger } from '../utils/logger.ts';

// Logged under the bridge's scope on purpose: the watchdog lines are part of
// the per-session transcript operators already grep for.
const log = createLogger('realtime-bridge');

/**
 * Owns the follow-up state the bridge used to poke as raw booleans:
 *
 * - `pending` / `retried` — the empty-follow-up retry. The Realtime API
 *   sporadically completes the response.create issued after a tool batch with
 *   ZERO output items (observed when it races the user's next utterance).
 *   Without a retry the tool has executed but the user hears nothing and the
 *   device silently drops to idle. `pending` is armed when the follow-up is
 *   requested; an empty *completed* response.done while armed gets ONE retry
 *   (`retried` guards against looping on a model that insists on staying
 *   silent). A cancelled response is a barge-in, not a loss — never retried,
 *   the new turn produces its own response.
 *
 * - `windowRequested` — request_follow_up's tool contract is "call this AFTER
 *   speaking a question", but the model sometimes calls it without speaking at
 *   all — opening the device mic window then means a silent 12s window and a
 *   user who never hears what went wrong (seen live after a schedule_action
 *   error). Only response.done knows whether the response carried a message,
 *   so the tool handler just arms this flag and response.done either opens
 *   the window (model spoke) or reuses the empty-follow-up retry (it didn't).
 *
 * - the watchdog — tracks an in-flight request_follow_up window so we can tell
 *   the difference (in logs) between "user answered the model's question
 *   within the window" and "window expired in silence". The device's
 *   follow-up state is hidden from us — we approximate by running a
 *   timer that matches the device-side window: the yaml on_followup_opened
 *   pre-mic delay (wake chime + drain wait + ~800ms, roughly 1.5s) plus the
 *   device's kRequestFollowUpMs (10000ms) mic-open window, plus a small slack,
 *   so the log fires *just after* the device-side timeout if no speech_started
 *   came in. The 12s value is kept in sync with the yaml followup_window_watchdog.
 */
export class FollowUpController {
  private readonly sessionId: string;
  private pending = false;
  private retried = false;
  private windowRequested = false;
  private watchdog: { sentAt: number; timer: NodeJS.Timeout } | null = null;
  private static readonly FOLLOW_UP_WINDOW_MS = 12_000;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  /** request_follow_up tool handler: defer the mic window to response.done,
   * which knows whether the model actually spoke. */
  requestWindow(): void {
    this.windowRequested = true;
  }

  /** A new turn (wake word) or an abort supersedes any deferred window. */
  cancelWindowRequest(): void {
    this.windowRequested = false;
  }

  /** Consume the deferred request_follow_up window at response.done. */
  takeWindowRequest(): boolean {
    const requested = this.windowRequested;
    this.windowRequested = false;
    return requested;
  }

  /** A follow-up response was just requested after a tool batch — an empty
   * completion is now a loss worth retrying (fresh retry budget). */
  armPending(): void {
    this.pending = true;
    this.retried = false;
  }

  isPending(): boolean {
    return this.pending;
  }

  /** The turn produced a usable outcome (or is being given up on) — a later
   * empty response must not be mistaken for a lost tool confirmation. */
  clearPending(): void {
    this.pending = false;
  }

  /** One retry per turn, shared by the silent-request_follow_up and
   * empty-follow-up paths. Returns whether the caller may issue the retry
   * response.create; arming `pending` makes the retried response subject to
   * the same emptiness check. */
  tryRetry(): boolean {
    if (this.retried) {
      return false;
    }
    this.retried = true;
    this.pending = true;
    return true;
  }

  /** Upstream session died: every in-flight follow-up belonged to it. A stray
   * empty response on the next session must not trigger a bogus retry, and
   * there is no window left to watch. */
  reset(): void {
    this.clearWatchdog();
    this.pending = false;
    this.retried = false;
    this.windowRequested = false;
  }

  /**
   * Start a soft timeout matched to the device's follow-up window so we can
   * log when nothing came back. The bridge doesn't get an explicit signal
   * for "device closed the mic" — speech_started would arrive *only* if the
   * user actually answered, and silence == no event at all. Without this
   * timer there would be no log line that says "the user ignored the
   * model's question," which makes "why didn't the assistant act on the
   * follow-up?" much harder to debug.
   */
  armWatchdog(): void {
    this.clearWatchdog();
    const sentAt = Date.now();
    const timer = setTimeout(() => {
      log.info(
        { sessionId: this.sessionId, windowMs: FollowUpController.FOLLOW_UP_WINDOW_MS },
        'request_follow_up window expired — user did not respond',
      );
      this.watchdog = null;
    }, FollowUpController.FOLLOW_UP_WINDOW_MS);
    // Don't keep the event loop alive solely for this timer.
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
    this.watchdog = { sentAt, timer };
  }

  /** Called when the user re-engages (speech_started, or a wake word) — if we
   * were waiting on a request_follow_up reply, this is it. Cancel the watchdog
   * so the "expired" line doesn't also fire. */
  noteUserSpeech(): void {
    if (this.watchdog === null) {
      return;
    }
    const latencyMs = Date.now() - this.watchdog.sentAt;
    log.info(
      { sessionId: this.sessionId, latencyMs },
      `request_follow_up — user responded after ${latencyMs}ms`,
    );
    this.clearWatchdog();
  }

  clearWatchdog(): void {
    if (this.watchdog === null) {
      return;
    }
    clearTimeout(this.watchdog.timer);
    this.watchdog = null;
  }
}
