import { REALTIME_BYTES_PER_SEC } from './format.ts';

const RATE = REALTIME_BYTES_PER_SEC / 2;

export const EARCON_KINDS = ['on', 'off', 'done'] as const;
export type EarconKind = (typeof EARCON_KINDS)[number];

// Two bell notes [Hz, start ms]: rising = on, falling = off, repeated = done.
const C5 = 523.25;
const E5 = 659.25;
const G5 = 783.99;
const NOTES: Record<EarconKind, Array<[number, number]>> = {
  on: [
    [C5, 0],
    [G5, 110],
  ],
  off: [
    [G5, 0],
    [C5, 110],
  ],
  done: [
    [E5, 0],
    [E5, 110],
  ],
};

const cache = new Map<EarconKind, Buffer>();

/** Silent-ack earcon as PCM16 mono @ 24 kHz — the Realtime reply format, so it
 *  rides the normal reply path to the device. Synthesized once per kind. */
export function earconPcm24k(kind: EarconKind): Buffer {
  let pcm = cache.get(kind);
  if (pcm === undefined) {
    pcm = synthesize(NOTES[kind]);
    cache.set(kind, pcm);
  }
  return pcm;
}

function synthesize(notes: Array<[number, number]>): Buffer {
  const at = (ms: number): number => Math.round((RATE * ms) / 1000);
  const lead = at(40); // the device can swallow the first ms of playback
  const decay = at(120);
  const noteLen = decay * 5;
  const lastStart = Math.max(...notes.map(([, start]) => start));
  const mix = new Float64Array(lead + at(lastStart) + noteLen + at(40));
  for (const [hz, startMs] of notes) {
    const s0 = lead + at(startMs);
    for (let i = 0; i < noteLen; i++) {
      // Bell-ish: fundamental + two overtones that die faster, 4 ms attack.
      const w = (2 * Math.PI * hz * i) / RATE;
      const env = Math.min(1, i / at(4)) * Math.exp(-i / decay);
      const tone =
        Math.sin(w) +
        0.25 * Math.exp((-0.3 * i) / decay) * Math.sin(2 * w) +
        0.08 * Math.exp((-0.6 * i) / decay) * Math.sin(3 * w);
      mix[s0 + i]! += env * tone;
    }
  }
  const peak = Math.max(...mix.map(Math.abs));
  const buf = Buffer.alloc(mix.length * 2);
  mix.forEach((v, i) => buf.writeInt16LE(Math.round((v / peak) * 0.38 * 32767), i * 2));
  return buf;
}
