/**
 * Programmatic 16-bit mono PCM chimes — no external audio files.
 * Both work identically on Mac (CoreAudio) and Pi (ALSA).
 */

const MAX_SAMPLE = 32767;

function clampInt16(v: number): number {
  return Math.max(-32768, Math.min(MAX_SAMPLE, Math.round(v)));
}

function twoToneBlip(
  sampleRate: number,
  segments: { freq: number; durMs: number }[],
  amplitude = 0.2,
): Buffer {
  const totalSamples = segments.reduce(
    (s, seg) => s + Math.floor((sampleRate * seg.durMs) / 1000),
    0,
  );
  const buf = Buffer.alloc(totalSamples * 2);
  let pos = 0;
  for (const seg of segments) {
    const segSamples = Math.floor((sampleRate * seg.durMs) / 1000);
    const attackSamples = Math.floor((sampleRate * 5) / 1000);
    const releaseSamples = Math.floor((sampleRate * 20) / 1000);
    for (let j = 0; j < segSamples; j++) {
      const t = j / sampleRate;
      let envelope = 1;
      if (j < attackSamples) envelope = j / attackSamples;
      else if (segSamples - j < releaseSamples) envelope = (segSamples - j) / releaseSamples;
      const sample = Math.sin(2 * Math.PI * seg.freq * t) * envelope * amplitude * MAX_SAMPLE;
      buf.writeInt16LE(clampInt16(sample), pos * 2);
      pos++;
    }
  }
  return buf;
}

/** "I'm listening" — three-note ascending chord G4→B4→D5. */
export function generateListenBlip(sampleRate = 24000): Buffer {
  return twoToneBlip(sampleRate, [
    { freq: 392.0, durMs: 55 }, // G4
    { freq: 493.88, durMs: 55 }, // B4
    { freq: 587.33, durMs: 75 }, // D5
  ]);
}

/** "Turned ON" — ascending C5→E5. */
export function generateConfirmOnBlip(sampleRate = 24000): Buffer {
  return twoToneBlip(
    sampleRate,
    [
      { freq: 523.25, durMs: 55 }, // C5
      { freq: 659.25, durMs: 100 }, // E5
    ],
    0.22,
  );
}

/** "Turned OFF" — descending E5→C5. */
export function generateConfirmOffBlip(sampleRate = 24000): Buffer {
  return twoToneBlip(
    sampleRate,
    [
      { freq: 659.25, durMs: 70 }, // E5
      { freq: 523.25, durMs: 100 }, // C5
    ],
    0.22,
  );
}

/** "Neutral action done" (e.g. set a value) — single C5 with decay. */
export function generateConfirmBlip(sampleRate = 24000): Buffer {
  const durationMs = 220;
  const freq = 523.25; // C5
  const numSamples = Math.floor((sampleRate * durationMs) / 1000);
  const buf = Buffer.alloc(numSamples * 2);
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const envelope = Math.exp(-t * 12);
    const sample = Math.sin(2 * Math.PI * freq * t) * envelope * 0.25 * MAX_SAMPLE;
    buf.writeInt16LE(clampInt16(sample), i * 2);
  }
  return buf;
}

/** Marker variants the LLM emits when an action completed with no speech needed. */
export const ACK_ON_MARKER = '✓+'; // device turned on / opened / activated
export const ACK_OFF_MARKER = '✓-'; // device turned off / closed / deactivated
export const ACK_MARKER = '✓'; // neutral action (set value, etc.)

export type AckVariant = 'on' | 'off' | 'neutral';

/** True if the agent reply is *only* an ack marker (possibly with whitespace). */
export function isAckOnly(text: string): boolean {
  const t = text.trim();
  return t === ACK_MARKER || t === ACK_ON_MARKER || t === ACK_OFF_MARKER;
}

/** Returns which ack variant the text is, or null if it's not an ack. */
export function getAckVariant(text: string): AckVariant | null {
  const t = text.trim();
  if (t === ACK_ON_MARKER) return 'on';
  if (t === ACK_OFF_MARKER) return 'off';
  if (t === ACK_MARKER) return 'neutral';
  return null;
}
