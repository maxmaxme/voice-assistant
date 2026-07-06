import { describe, it, expect } from 'vitest';
import { createWakeArbiter } from '../../src/realtime/wakeArbiter.ts';

describe('createWakeArbiter', () => {
  it('lets the first claimant win and rejects a co-located second within the window', () => {
    const arbiter = createWakeArbiter(1_500);
    const a = {};
    const b = {};

    expect(arbiter.claim(a, 1_000)).toBe(true); // first wake wins
    expect(arbiter.claim(b, 1_150)).toBe(false); // same phrase, ~150 ms later → loses
  });

  it('lets a different device win once the dedup window has passed', () => {
    const arbiter = createWakeArbiter(1_500);
    const a = {};
    const b = {};

    expect(arbiter.claim(a, 1_000)).toBe(true);
    expect(arbiter.claim(b, 2_600)).toBe(true); // 1.6 s later → a separate turn
  });

  it('lets the current winner re-claim freely (barge-in on its own turn)', () => {
    const arbiter = createWakeArbiter(1_500);
    const a = {};

    expect(arbiter.claim(a, 1_000)).toBe(true);
    expect(arbiter.claim(a, 1_100)).toBe(true); // same device, within window
  });

  it('a rejected claim does not extend the window or become the winner', () => {
    const arbiter = createWakeArbiter(1_500);
    const a = {};
    const b = {};
    const c = {};

    expect(arbiter.claim(a, 1_000)).toBe(true);
    expect(arbiter.claim(b, 1_400)).toBe(false); // b loses, must not reset the clock
    // c comes 1.6 s after a's win — a's window has expired, b's loss didn't renew it.
    expect(arbiter.claim(c, 2_600)).toBe(true);
  });

  it('measures the window from the winner, and the winner keeps extending it', () => {
    const arbiter = createWakeArbiter(1_000);
    const a = {};
    const b = {};

    expect(arbiter.claim(a, 0)).toBe(true);
    expect(arbiter.claim(a, 900)).toBe(true); // winner re-claim moves the window
    expect(arbiter.claim(b, 1_500)).toBe(false); // still within 1 s of a's last claim (900)
  });
});
