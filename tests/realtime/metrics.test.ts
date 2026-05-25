import { describe, it, expect } from 'vitest';
import { LatencyTracker } from '../../src/realtime/metrics.ts';

describe('LatencyTracker', () => {
  it('reports deltas between markers', () => {
    let now = 1000;
    const t = new LatencyTracker(() => now);
    t.mark('start');
    now = 1100;
    t.mark('first_audio_in');
    now = 1500;
    t.mark('first_audio_out');
    const r = t.report();
    expect(r['start→first_audio_in']).toBe(100);
    expect(r['first_audio_in→first_audio_out']).toBe(400);
    expect(r['start→first_audio_out']).toBe(500);
  });
});
