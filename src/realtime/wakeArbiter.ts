/** Co-located wake-word arbitration for the realtime WS server.
 *
 * When several speakers share a room, one spoken "okay nabu" fires the wake
 * word on all of them and each opens a turn → duplicate responses. Every device
 * has its own RealtimeBridge and can't see the others; this shared arbiter is
 * the single point that can. First-come-first-served: the first `start` within
 * a short window wins, the rest are told to abort back to idle.
 *
 * A short time window (not a turn-long lock) is deliberate. It dedupes a single
 * wake *event* — the near-simultaneous starts from one spoken phrase — without
 * blocking a genuinely separate turn on another device a couple seconds later
 * (e.g. speakers in different rooms). So it fixes the same-room double-answer
 * without breaking multi-room use.
 */
export interface WakeArbiter {
  /** Record a wake `start` from `claimant` at `nowMs`. Returns true if it may
   *  open a turn, false if another claimant already won within the dedup window
   *  (this one must abort back to idle). The current winner may re-claim freely
   *  — that's a barge-in on its own turn, not a competing device. */
  claim(claimant: object, nowMs: number): boolean;
}

export function createWakeArbiter(windowMs: number): WakeArbiter {
  let winner: object | null = null;
  let wonAt = 0;
  return {
    claim(claimant: object, nowMs: number): boolean {
      const contested = winner !== null && winner !== claimant && nowMs - wonAt < windowMs;
      if (contested) {
        return false;
      }
      winner = claimant;
      wonAt = nowMs;
      return true;
    },
  };
}
