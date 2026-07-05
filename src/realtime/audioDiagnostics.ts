import { createLogger } from '../utils/logger.ts';
import { REALTIME_BYTES_PER_SEC } from './audio/format.ts';

// Logged under the bridge's scope on purpose: these lines are part of the
// per-session transcript operators already grep for.
const log = createLogger('realtime-bridge');

/**
 * Audio delivery diagnostics — pure telemetry, no behaviour coupling.
 *
 * Mirror of the firmware's ws-gap / underrun detectors, but on the
 * OpenAI→bridge edge. The device stutters when audio arrives slower than it
 * plays; this tells us whether that slowness originates upstream (OpenAI
 * streaming sub-realtime) or on our side. Tracked per response: delta count,
 * total PCM bytes, first/last arrival, and inter-delta gaps. At response.done
 * we log the effective delivery rate vs real time — PCM16 mono @24kHz is
 * 48000 bytes/sec, so rate < 1.0 means upstream can't keep up and no amount
 * of client-side buffering can hide the stutter.
 */
export class AudioDiagnostics {
  private readonly sessionId: string;
  private deltas = 0;
  private bytes = 0;
  private firstMs = 0;
  private lastMs = 0;
  private gapCount = 0;
  private maxGapMs = 0;
  // Loud-garbage detector: counts deltas where most samples sit near full
  // scale. Real speech peaks but doesn't sustain near ±32767; white-noise
  // garbage does. If the bridge logs noisy chunks, the corruption is upstream
  // (OpenAI / this process); if it stays 0 while the speaker still hisses, the
  // garbage is introduced device-side (firmware ring / resampler / DAC).
  private noisyChunks = 0;
  private static readonly GAP_WARN_MS = 150;
  private static readonly NOISE_LEVEL = 19_660; // ~0.6 × 32767
  private static readonly NOISE_RATIO = 0.5; // share of samples above level

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  /** Track one OpenAI→bridge audio delta (already past the drop filter):
   * inter-arrival gap for the delivery-rate metric, plus a loud-garbage check
   * so we can tell whether noise originates upstream. */
  record(pcm: Buffer): void {
    const byteLength = pcm.length;
    const now = Date.now();
    if (this.firstMs === 0) {
      this.firstMs = now;
    } else {
      const gap = now - this.lastMs;
      if (gap > AudioDiagnostics.GAP_WARN_MS) {
        this.gapCount++;
        if (gap > this.maxGapMs) {
          this.maxGapMs = gap;
        }
        log.debug(
          { gapMs: gap, deltaBytes: byteLength, sessionId: this.sessionId },
          'openai audio delta gap',
        );
      }
    }
    this.lastMs = now;
    this.deltas++;
    this.bytes += byteLength;

    // Loud-garbage check. Sample every 4th PCM16 frame (stride 8 bytes) and
    // count how many sit near full scale; a chunk that's mostly near-max is
    // noise, not speech.
    const samples = Math.floor(byteLength / 2);
    if (samples > 0) {
      let scanned = 0;
      let loud = 0;
      for (let i = 0; i + 1 < byteLength; i += 8) {
        const s = pcm.readInt16LE(i);
        scanned++;
        if (s > AudioDiagnostics.NOISE_LEVEL || s < -AudioDiagnostics.NOISE_LEVEL) {
          loud++;
        }
      }
      const ratio = scanned > 0 ? loud / scanned : 0;
      if (ratio >= AudioDiagnostics.NOISE_RATIO) {
        this.noisyChunks++;
        log.debug(
          { ratio: Number(ratio.toFixed(2)), bytes: byteLength, sessionId: this.sessionId },
          'openai sent a near-full-scale (noise-like) audio chunk',
        );
      }
    }
  }

  /** Reset the per-response counters. Called on response.created so each
   * response (preamble vs post-tool-call follow-up) is measured on its own. */
  reset(): void {
    this.deltas = 0;
    this.bytes = 0;
    this.firstMs = 0;
    this.lastMs = 0;
    this.gapCount = 0;
    this.maxGapMs = 0;
    this.noisyChunks = 0;
  }

  /** Summarise the finished response's delivery. No-op when the response
   * carried no audio. */
  logDelivery(responseId: string): void {
    if (this.deltas === 0) {
      return;
    }
    const wallMs = this.lastMs - this.firstMs;
    const audioMs = (this.bytes / REALTIME_BYTES_PER_SEC) * 1000;
    const rate = wallMs > 0 ? audioMs / wallMs : 0;
    // rate < 1.0 ⇒ OpenAI streamed this response slower than real time
    // (the device cannot help but stutter). rate ≥ 1.0 ⇒ upstream was
    // fast enough and any stutter is downstream of here.
    log.debug(
      {
        responseId,
        deltas: this.deltas,
        audioMs: Math.round(audioMs),
        wallMs,
        rate: Number(rate.toFixed(2)),
        gaps: this.gapCount,
        maxGapMs: this.maxGapMs,
        noisyChunks: this.noisyChunks,
        sessionId: this.sessionId,
      },
      'openai audio delivery',
    );
    if (this.noisyChunks > 0) {
      // Visible at default (info) level: OpenAI actually streamed
      // near-full-scale (noise-like) audio. If this fires while the
      // speaker hisses, the garbage is upstream, not device-side.
      log.warn(
        {
          responseId,
          noisyChunks: this.noisyChunks,
          deltas: this.deltas,
          sessionId: this.sessionId,
        },
        'openai sent noise-like audio this response',
      );
    }
  }
}
