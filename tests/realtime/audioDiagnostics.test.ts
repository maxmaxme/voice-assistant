import { describe, it, expect } from 'vitest';
import { AudioDiagnostics } from '../../src/realtime/audioDiagnostics.ts';
import { captureLogs } from '../helpers/captureLogs.ts';

// A quiet chunk: all-zero samples (silence — nowhere near full scale).
function quietChunk(bytes = 960): Buffer {
  return Buffer.alloc(bytes);
}

// A noise-like chunk: every sample pinned at full scale.
function noisyChunk(bytes = 960): Buffer {
  const buf = Buffer.alloc(bytes);
  for (let i = 0; i + 1 < bytes; i += 2) {
    buf.writeInt16LE(32_000, i);
  }
  return buf;
}

describe('AudioDiagnostics', () => {
  it('logs a delivery summary for a response that carried audio', () => {
    const diag = new AudioDiagnostics('sess1');
    const logs = captureLogs();
    try {
      diag.record(quietChunk());
      diag.record(quietChunk());
      diag.logDelivery('r1');
      expect(logs.text()).toMatch(/openai audio delivery/);
      expect(logs.text()).toMatch(/"deltas":2/);
      expect(logs.text()).toMatch(/"responseId":"r1"/);
      expect(logs.text()).toMatch(/"sessionId":"sess1"/);
    } finally {
      logs.restore();
    }
  });

  it('stays silent for a response with no audio', () => {
    const diag = new AudioDiagnostics('sess1');
    const logs = captureLogs();
    try {
      diag.logDelivery('r1');
      expect(logs.text()).toBe('');
    } finally {
      logs.restore();
    }
  });

  it('flags near-full-scale chunks as noise and warns at response end', () => {
    const diag = new AudioDiagnostics('sess1');
    const logs = captureLogs();
    try {
      diag.record(noisyChunk());
      expect(logs.text()).toMatch(/near-full-scale \(noise-like\) audio chunk/);
      diag.logDelivery('r1');
      expect(logs.text()).toMatch(/openai sent noise-like audio this response/);
      expect(logs.text()).toMatch(/"noisyChunks":1/);
    } finally {
      logs.restore();
    }
  });

  it('does not warn about noise when the audio is quiet', () => {
    const diag = new AudioDiagnostics('sess1');
    const logs = captureLogs();
    try {
      diag.record(quietChunk());
      diag.logDelivery('r1');
      expect(logs.text()).not.toMatch(/noise-like audio this response/);
    } finally {
      logs.restore();
    }
  });

  it('reset starts the next response from a clean slate', () => {
    const diag = new AudioDiagnostics('sess1');
    const logs = captureLogs();
    try {
      diag.record(noisyChunk());
      diag.reset();
      diag.logDelivery('r2');
      // No deltas recorded since reset — nothing to summarise.
      expect(logs.text()).not.toMatch(/openai audio delivery/);
    } finally {
      logs.restore();
    }
  });
});
