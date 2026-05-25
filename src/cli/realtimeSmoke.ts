import { readFileSync, createWriteStream } from 'node:fs';
import WebSocket from 'ws';
import { createLogger } from '../utils/logger.ts';

const log = createLogger('realtime-smoke');

const wavPath = process.argv[2];
const token = process.env.VA_DEVICE_TOKEN;
const host = process.env.REALTIME_HOST ?? '127.0.0.1';
const port = Number(process.env.REALTIME_PORT ?? '3001');

if (!wavPath || !token) {
  console.error('usage: VA_DEVICE_TOKEN=... node src/cli/realtimeSmoke.ts <wav>');
  process.exit(2);
}

function readWavPcm16Mono16k(path: string): Buffer {
  const buf = readFileSync(path);

  // Find the fmt chunk
  const fmtIdx = buf.indexOf('fmt ');
  if (fmtIdx < 0) {
    throw new Error('not a wav: missing fmt chunk');
  }

  // Read WAVE format fields
  const numChannels = buf.readUInt16LE(fmtIdx + 8);
  const sampleRate = buf.readUInt32LE(fmtIdx + 12);
  const bitsPerSample = buf.readUInt16LE(fmtIdx + 22);

  if (sampleRate !== 16000 || numChannels !== 1 || bitsPerSample !== 16) {
    throw new Error(
      `need 16kHz mono pcm16, got ${sampleRate}Hz ${numChannels}ch ${bitsPerSample}bit`,
    );
  }

  // Find the data chunk
  const dataIdx = buf.indexOf('data');
  if (dataIdx < 0) {
    throw new Error('not a wav: missing data chunk');
  }

  // Read the data length and extract PCM
  const dataLen = buf.readUInt32LE(dataIdx + 4);
  return buf.subarray(dataIdx + 8, dataIdx + 8 + dataLen);
}

async function main(): Promise<void> {
  let pcmData: Buffer;
  try {
    pcmData = readWavPcm16Mono16k(wavPath);
  } catch (err) {
    log.error({ err }, 'Failed to read WAV file');
    process.exit(2);
  }

  const outStream = createWriteStream('out.pcm');

  let firstAudioOutTs: number | null = null;
  let connectTs: number;
  let audioSendInterval: NodeJS.Timeout | null = null;
  let safetyTimeout: NodeJS.Timeout | null = null;
  let endOfTurnTimer: NodeJS.Timeout | null = null;
  let ws: WebSocket | null = null;
  let closed = false;
  const QUIET_AFTER_AUDIO_MS = 1000; // close 1s after last audio chunk

  const cleanup = (): Promise<void> => {
    if (audioSendInterval) {
      clearInterval(audioSendInterval);
      audioSendInterval = null;
    }
    if (safetyTimeout) {
      clearTimeout(safetyTimeout);
      safetyTimeout = null;
    }
    if (endOfTurnTimer) {
      clearTimeout(endOfTurnTimer);
      endOfTurnTimer = null;
    }
    if (ws) {
      ws.close();
      ws = null;
    }
    return new Promise<void>((resolve) => {
      outStream.end(() => resolve());
    });
  };

  const scheduleEndOfTurn = (): void => {
    if (endOfTurnTimer) {
      clearTimeout(endOfTurnTimer);
    }
    endOfTurnTimer = setTimeout(() => {
      log.info(`no audio for ${QUIET_AFTER_AUDIO_MS}ms after reply — closing`);
      exit(0);
    }, QUIET_AFTER_AUDIO_MS);
  };

  const exit = (code: number): void => {
    if (!closed) {
      closed = true;
      void cleanup().then(() => {
        const bytes = outStream.bytesWritten;
        log.info({ bytes, path: 'out.pcm' }, 'wrote pcm');
        process.exit(code);
      });
    }
  };

  // Connect to WebSocket
  const url = `ws://${host}:${port}/voice`;
  ws = new WebSocket(url, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  ws.on('open', () => {
    connectTs = Date.now();
    log.info('connected');

    // Send start command
    ws!.send(JSON.stringify({ type: 'start' }));

    // Stream PCM in 20ms chunks (640 bytes @ 16kHz pcm16)
    const chunkSize = 640;
    let bytesSent = 0;

    audioSendInterval = setInterval(() => {
      if (!ws) {
        return;
      }

      if (bytesSent >= pcmData.length) {
        if (audioSendInterval) {
          clearInterval(audioSendInterval);
          audioSendInterval = null;
        }
        log.info('all audio sent');
        return;
      }

      const endIdx = Math.min(bytesSent + chunkSize, pcmData.length);
      const chunk = pcmData.subarray(bytesSent, endIdx);
      ws!.send(chunk);
      bytesSent = endIdx;
    }, 20);
  });

  ws.on('message', (data: WebSocket.RawData) => {
    // Handle binary and text messages
    if (Buffer.isBuffer(data)) {
      // Binary frame — PCM audio
      if (firstAudioOutTs === null) {
        firstAudioOutTs = Date.now();
        const latencyMs = firstAudioOutTs - connectTs;
        log.info(`first audio out: ${latencyMs}ms`);
      }
      outStream.write(data);
      scheduleEndOfTurn();
    } else {
      // Text frame — control message
      try {
        const text = typeof data === 'string' ? data : data.toString();
        const parsed = JSON.parse(text);
        log.info({ control: parsed }, 'control');
      } catch {
        // Couldn't parse JSON, just log raw
        log.info({ raw: data }, 'control (unparsed)');
      }
    }
  });

  ws.on('close', (code: number) => {
    log.info({ code }, 'closed');
    exit(0);
  });

  ws.on('error', (err: Error) => {
    log.error({ err }, 'WS error');
    exit(1);
  });

  // Safety timeout: 30 seconds from connect
  safetyTimeout = setTimeout(() => {
    log.warn('30s timeout reached, closing');
    if (ws) {
      ws.close();
    }
    exit(0);
  }, 30000);
}

main().catch((err) => {
  log.error({ err }, 'Unhandled error');
  process.exit(1);
});
