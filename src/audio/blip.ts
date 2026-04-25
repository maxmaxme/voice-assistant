/**
 * Generate a short, pleasant confirmation chime as 16-bit mono PCM.
 * No external file shipped — programmatic so it works identically on Mac and Pi.
 */
export function generateConfirmBlip(sampleRate = 24000): Buffer {
  const durationMs = 220;
  const freq = 880; // A5 — bright, attention-grabbing without being shrill
  const numSamples = Math.floor((sampleRate * durationMs) / 1000);
  const buf = Buffer.alloc(numSamples * 2);
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    // Exponential decay envelope — bell-like, fades to zero by ~150ms
    const envelope = Math.exp(-t * 12);
    const sample = Math.sin(2 * Math.PI * freq * t) * envelope * 0.25 * 32767;
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sample))), i * 2);
  }
  return buf;
}

/** Marker the LLM emits when an action completed and no speech is warranted. */
export const ACK_MARKER = '✓'; // ✓

/** Returns true if the agent reply is *only* the ack marker (possibly with whitespace). */
export function isAckOnly(text: string): boolean {
  return text.trim() === ACK_MARKER;
}
