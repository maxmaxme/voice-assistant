/**
 * Programmatic 16-bit mono PCM chimes — no external audio files.
 * Both work identically on Mac (CoreAudio) and Pi (ALSA).
 */

const MAX_SAMPLE = 32767;

function clampInt16(v: number): number {
  return Math.max(-32768, Math.min(MAX_SAMPLE, Math.round(v)));
}

/** "Action completed" — single bright tone with a long decay. */
export function generateConfirmBlip(sampleRate = 24000): Buffer {
  const durationMs = 220;
  const freq = 880; // A5
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

/** "I'm listening" — quick ascending two-tone (E5 → A5), feels open / inviting. */
export function generateListenBlip(sampleRate = 24000): Buffer {
  const segments = [
    { freq: 659.25, durMs: 60 }, // E5
    { freq: 880, durMs: 80 }, // A5
  ];
  const totalSamples = segments.reduce(
    (s, seg) => s + Math.floor((sampleRate * seg.durMs) / 1000),
    0,
  );
  const buf = Buffer.alloc(totalSamples * 2);
  let pos = 0;
  for (const seg of segments) {
    const segSamples = Math.floor((sampleRate * seg.durMs) / 1000);
    const attackSamples = Math.floor((sampleRate * 5) / 1000);
    const releaseSamples = Math.floor((sampleRate * 15) / 1000);
    for (let j = 0; j < segSamples; j++) {
      const t = j / sampleRate;
      let envelope = 1;
      if (j < attackSamples) envelope = j / attackSamples;
      else if (segSamples - j < releaseSamples) envelope = (segSamples - j) / releaseSamples;
      const sample = Math.sin(2 * Math.PI * seg.freq * t) * envelope * 0.2 * MAX_SAMPLE;
      buf.writeInt16LE(clampInt16(sample), pos * 2);
      pos++;
    }
  }
  return buf;
}

/** Marker the LLM emits when an action completed and no speech is warranted. */
export const ACK_MARKER = '✓';

/** True if the agent reply is *only* the ack marker (possibly with whitespace). */
export function isAckOnly(text: string): boolean {
  return text.trim() === ACK_MARKER;
}
