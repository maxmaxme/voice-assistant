/**
 * Build a RIFF/WAVE container around a stream of 16-bit signed little-endian
 * mono PCM chunks (the format our TTS adapters emit).
 *
 * Used by the HTTP `/converse` endpoint to ship a single-shot audio reply to
 * thin clients (Voice PE custom firmware, mac test scripts, etc.) that play
 * a complete file rather than streaming raw PCM through a DAC.
 *
 * Format constraints, hard-coded to match `OpenAiTts` / `ElevenLabsTts`:
 *   - 16-bit signed PCM
 *   - mono
 *   - little-endian samples
 *
 * Sample rate is parameterised because TTS providers ship at different rates
 * (OpenAI = 24 kHz, ElevenLabs = 24 kHz too at the moment but could change).
 */
export async function streamPcmToWav(
  chunks: AsyncIterable<Buffer>,
  sampleRate: number,
): Promise<Buffer> {
  const parts: Buffer[] = [];
  let dataLength = 0;
  for await (const chunk of chunks) {
    parts.push(chunk);
    dataLength += chunk.length;
  }
  const header = buildWavHeader({ dataLength, sampleRate });
  return Buffer.concat([header, ...parts]);
}

/**
 * Streaming variant: yields a placeholder-length WAV header first, then each
 * PCM chunk as it arrives. The RIFF and data sub-chunk sizes are written as
 * `0xFFFFFFFF` — the de-facto convention for streaming WAVs of unknown total
 * length. Decoders that respect EOF (afplay, ffmpeg, ESPHome media_player)
 * play until the connection closes; strict decoders that demand correct
 * lengths will not, but those are rare for our targets.
 *
 * Use this when the producer is incremental (e.g. OpenAI TTS streaming
 * partial audio) and you want the client to start playing before the entire
 * utterance is synthesised.
 */
export async function* streamPcmToWavChunks(
  chunks: AsyncIterable<Buffer>,
  sampleRate: number,
): AsyncGenerator<Buffer> {
  yield buildWavHeader({ dataLength: 0xffffffff - 36, sampleRate });
  for await (const chunk of chunks) {
    yield chunk;
  }
}

interface WavHeaderOpts {
  dataLength: number;
  sampleRate: number;
}

function buildWavHeader(opts: WavHeaderOpts): Buffer {
  const { dataLength, sampleRate } = opts;
  const channels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;

  const header = Buffer.alloc(44);
  // RIFF chunk
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataLength, 4); // file size - 8
  header.write('WAVE', 8, 'ascii');
  // fmt sub-chunk
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // PCM format = 1
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  // data sub-chunk
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataLength, 40);
  return header;
}
