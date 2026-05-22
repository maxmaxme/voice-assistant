#!/usr/bin/env node
/**
 * End-to-end smoke test for the HTTP `/converse` endpoint.
 *
 * Records from the default microphone (push-to-talk: Enter to start, Enter
 * again to stop), POSTs the captured audio to /converse, then plays the WAV
 * reply via `afplay` (macOS) or `aplay` (Linux). Headers `x-transcript` and
 * `x-response` are logged so you can see what the server understood and what
 * the agent replied without parsing the audio.
 *
 * Usage:
 *
 *   # Server running locally
 *   npm run http                                # in another terminal
 *
 *   # Defaults: http://localhost:3000, key from HTTP_API_KEYS[0] in .env
 *   node scripts/converse-test.ts
 *
 *   # Or point at a remote (e.g. Pi)
 *   CONVERSE_URL=http://pi.local:3000/converse \
 *   CONVERSE_API_KEY=device1-key \
 *   node scripts/converse-test.ts
 *
 * Loops until you Ctrl+C, so you can do several turns in a row.
 */

import 'dotenv/config';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { NodeMicInput } from '../src/audio/micInput.ts';
import { streamPcmToWav } from '../src/audio/wavWriter.ts';

const SAMPLE_RATE = 16000;
const DEFAULT_URL = 'http://localhost:3000/converse';

function resolveApiKey(): string {
  const fromOwn = process.env.CONVERSE_API_KEY?.trim();
  if (fromOwn) {
    return fromOwn;
  }
  const fromServer = (process.env.HTTP_API_KEYS ?? '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);
  if (fromServer.length === 0) {
    throw new Error('Set CONVERSE_API_KEY, or HTTP_API_KEYS in .env');
  }
  return fromServer[0]!;
}

function waitForEnter(prompt: string): Promise<void> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, () => {
      rl.close();
      resolve();
    });
  });
}

async function playWav(wavPath: string): Promise<void> {
  const cmd = process.platform === 'darwin' ? 'afplay' : 'aplay';
  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, [wavPath], { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${cmd} exited ${code}`));
      }
    });
  });
}

async function pcmToWavBuffer(pcm: Buffer, sampleRate: number): Promise<Buffer> {
  async function* one(): AsyncGenerator<Buffer> {
    yield pcm;
  }
  return streamPcmToWav(one(), sampleRate);
}

async function oneTurn(url: string, apiKey: string): Promise<void> {
  const mic = new NodeMicInput();

  await waitForEnter('Press Enter to start recording... ');
  process.stdout.write('🎙  Recording — press Enter to stop\n');
  const session = await mic.record({ sampleRate: SAMPLE_RATE });
  await waitForEnter('');
  const pcm = await session.stop();
  process.stdout.write(
    `Captured ${pcm.length} bytes of PCM (${(pcm.length / 2 / SAMPLE_RATE).toFixed(1)}s)\n`,
  );

  if (pcm.length === 0) {
    process.stdout.write('No audio captured, skipping\n');
    return;
  }

  const wav = await pcmToWavBuffer(pcm, SAMPLE_RATE);
  process.stdout.write(`POST ${url}  (${wav.length} bytes WAV)\n`);

  const t0 = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'audio/wav',
    },
    body: wav,
  });
  const elapsedMs = Date.now() - t0;

  if (!res.ok) {
    const text = await res.text();
    process.stdout.write(`✗ ${res.status} ${res.statusText} (${elapsedMs}ms): ${text}\n`);
    return;
  }
  if (res.status === 204) {
    process.stdout.write(`✓ 204 No Content — agent had nothing to say (${elapsedMs}ms)\n`);
    return;
  }

  const transcript = decodeURIComponent(res.headers.get('x-transcript') ?? '');
  const response = decodeURIComponent(res.headers.get('x-response') ?? '');
  process.stdout.write(`✓ ${res.status} in ${elapsedMs}ms\n`);
  process.stdout.write(`   transcript: ${transcript}\n`);
  process.stdout.write(`   response:   ${response}\n`);

  const replyWav = Buffer.from(await res.arrayBuffer());
  const replyPath = join(tmpdir(), `converse-reply-${Date.now()}.wav`);
  await writeFile(replyPath, replyWav);
  process.stdout.write(`   playing ${replyPath} (${replyWav.length} bytes)\n`);
  await playWav(replyPath);
}

async function main(): Promise<void> {
  const url = process.env.CONVERSE_URL ?? DEFAULT_URL;
  const apiKey = resolveApiKey();

  process.stdout.write(`converse-test → ${url}\n`);
  process.stdout.write('Ctrl+C to quit.\n\n');

  // Loop until Ctrl+C.

  while (true) {
    try {
      await oneTurn(url, apiKey);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`✗ ${msg}\n`);
    }
    process.stdout.write('\n');
  }
}

void main();
