/**
 * realtime-probe — measure how fast OpenAI's Realtime API actually streams
 * audio back, in isolation from the device, firmware, and the WS bridge.
 *
 * Why this exists: the Voice PE speaker stutters because audio deltas arrive
 * slower than real time. We proved the network (4.8 ms RTT, 0% loss), the Pi
 * CPU (idle), and the bridge forwarding (immediate) are all healthy — which
 * leaves OpenAI's own generation pace as the suspect, governed by the model
 * id and `reasoning.effort`. Deploying the whole container to test that is slow
 * and the symptom flakes ("sometimes fine, sometimes not"), so this script
 * hammers the API directly and prints the delivery rate per run.
 *
 * It sends a TEXT prompt and asks for an AUDIO response, then times the
 * `response.output_audio.delta` stream. Output-generation pace is what we're
 * chasing, and text input makes the test deterministic (no mic recording, no
 * server-VAD timing). The metric mirrors the bridge's `openai audio delivery`
 * log: rate = (audio seconds delivered) / (wall seconds taken). rate ≥ 1.0
 * means OpenAI keeps up with real time; rate < 1.0 means it can't and the
 * device cannot help but stutter.
 *
 * Usage (needs OPENAI_API_KEY in the env):
 *   OPENAI_API_KEY=sk-... node src/cli/realtime-probe.ts
 *   MODEL=gpt-realtime RUNS=5 MODE=cold node src/cli/realtime-probe.ts
 *   MODEL=gpt-realtime-2 REASONING=minimal MODE=warm RUNS=4 node src/cli/realtime-probe.ts
 *
 * Env knobs:
 *   OPENAI_API_KEY  required
 *   MODEL           realtime model id (default: OPENAI_REALTIME_MODEL || 'gpt-realtime')
 *   VOICE           TTS voice (default: OPENAI_REALTIME_VOICE || 'marin')
 *   REASONING       reasoning effort: minimal|low|medium|high|none (default: unset)
 *   PROMPT          user text prompt (default: a ~minute-long-answer ask)
 *   RUNS            how many responses to measure (default: 3)
 *   MODE            cold = fresh socket per run; warm = one socket, N responses (default: cold)
 *   GAP_WARN_MS     per-delta gap threshold to count (default: 150)
 */

import type { RealtimeServerEvent } from 'openai/resources/realtime/realtime';
import { OpenAiRealtimeClient } from '../realtime/openaiRealtimeClient.ts';
import type { ReasoningEffort } from '../realtime/openaiRealtimeClient.ts';

const REALTIME_BYTES_PER_SEC = 48_000; // PCM16 mono @ 24 kHz

interface RunResult {
  responseId: string;
  firstDeltaMs: number; // response.create → first audio delta
  deltas: number;
  audioMs: number; // seconds of audio delivered, ×1000
  wallMs: number; // first delta → last delta
  rate: number; // audioMs / wallMs
  gapCount: number;
  maxGapMs: number;
  transcript: string;
}

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') {
    console.error(`${name} is required`);
    process.exit(1);
  }
  return v;
}

/** Validate a free-text reasoning effort into the typed union without an
 * assertion — unknown / empty / 'none' means "don't set reasoning at all". */
function parseReasoning(v: string | undefined): ReasoningEffort | undefined {
  switch (v) {
    case 'minimal':
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
      return v;
    default:
      return undefined;
  }
}

const API_KEY = requireEnv('OPENAI_API_KEY');

const MODEL = env('MODEL', env('OPENAI_REALTIME_MODEL', 'gpt-realtime'));
const VOICE = env('VOICE', env('OPENAI_REALTIME_VOICE', 'marin'));
const REASONING = process.env.REASONING; // undefined → don't set reasoning at all
const PROMPT = env(
  'PROMPT',
  'Tell a detailed, engaging story about a smart home, roughly a minute long, without pauses.',
);
const RUNS = Number.parseInt(env('RUNS', '3'), 10);
const MODE = env('MODE', 'cold'); // 'cold' | 'warm'
const GAP_WARN_MS = Number.parseInt(env('GAP_WARN_MS', '150'), 10);

// reasoningEffort is typed on the client; pass it through only when set so the
// session.update omits `reasoning` entirely otherwise (matches the bridge).
const reasoningEffort = parseReasoning(REASONING);

function makeClient(): OpenAiRealtimeClient {
  return new OpenAiRealtimeClient({
    apiKey: API_KEY,
    model: MODEL,
    voice: VOICE,
    instructions: 'You are a concise voice assistant. Answer in the user language.',
    tools: [],
    reasoningEffort,
  });
}

/** Drive ONE response on an already-connected client and time its audio. */
function measureOneResponse(client: OpenAiRealtimeClient): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    let firstDeltaAt = 0;
    let lastDeltaAt = 0;
    let deltas = 0;
    let bytes = 0;
    let gapCount = 0;
    let maxGapMs = 0;
    let responseId = '?';
    let transcript = '';
    const createdAt = Date.now();

    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('timeout: no response.done within 120s'));
    }, 120_000);

    const listener = (ev: RealtimeServerEvent): void => {
      switch (ev.type) {
        case 'response.created':
          responseId = ev.response.id ?? '?';
          break;
        case 'response.output_audio.delta': {
          if (typeof ev.delta !== 'string') {
            break;
          }
          const now = Date.now();
          const len = Buffer.from(ev.delta, 'base64').length;
          if (firstDeltaAt === 0) {
            firstDeltaAt = now;
          } else {
            const gap = now - lastDeltaAt;
            if (gap > GAP_WARN_MS) {
              gapCount++;
              if (gap > maxGapMs) {
                maxGapMs = gap;
              }
            }
          }
          lastDeltaAt = now;
          deltas++;
          bytes += len;
          break;
        }
        case 'response.output_audio_transcript.done':
          if (typeof ev.transcript === 'string') {
            transcript = ev.transcript;
          }
          break;
        case 'response.done': {
          cleanup();
          const wallMs = firstDeltaAt === 0 ? 0 : lastDeltaAt - firstDeltaAt;
          const audioMs = (bytes / REALTIME_BYTES_PER_SEC) * 1000;
          const rate = wallMs > 0 ? audioMs / wallMs : 0;
          resolve({
            responseId,
            firstDeltaMs: firstDeltaAt === 0 ? 0 : firstDeltaAt - createdAt,
            deltas,
            audioMs: Math.round(audioMs),
            wallMs,
            rate: Number(rate.toFixed(2)),
            gapCount,
            maxGapMs,
            transcript,
          });
          break;
        }
        case 'error':
          cleanup();
          reject(new Error(`server error: ${JSON.stringify(ev)}`));
          break;
        default:
          break;
      }
    };

    function cleanup(): void {
      clearTimeout(timeout);
      // The client appends listeners; there's no removeListener, so we guard
      // by resolving once. A second response on a warm socket installs its own
      // listener via a fresh measureOneResponse() call — stale listeners from
      // resolved runs simply no-op because their promise already settled.
      settled = true;
    }

    let settled = false;
    const guarded = (ev: RealtimeServerEvent): void => {
      if (settled) {
        return;
      }
      listener(ev);
    };
    client.on(guarded);

    // Fail fast on an abnormal WS close (e.g. code 1006) instead of hanging
    // until the 120s timeout — the close itself is a finding worth surfacing.
    client.onClose((info) => {
      if (settled) {
        return;
      }
      cleanup();
      reject(
        new Error(
          `ws closed before response.done: code=${info.code} reason="${info.reason}" ` +
            `(got ${deltas} deltas, ${bytes} bytes so far)`,
        ),
      );
    });

    // Send the text turn and ask for an audio response.
    client.send({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: PROMPT }],
      },
    });
    client.requestResponse();
  });
}

function fmt(r: RunResult, i: number): string {
  const flag = r.rate >= 1.0 ? 'OK ' : 'SLOW';
  return (
    `run ${String(i + 1).padStart(2)} | ${flag} rate=${r.rate.toFixed(2)} | ` +
    `audio=${(r.audioMs / 1000).toFixed(1)}s in wall=${(r.wallMs / 1000).toFixed(1)}s | ` +
    `firstDelta=${r.firstDeltaMs}ms | deltas=${r.deltas} | ` +
    `gaps=${r.gapCount} (max=${r.maxGapMs}ms)`
  );
}

async function main(): Promise<void> {
  console.error(
    `realtime-probe: model=${MODEL} voice=${VOICE} reasoning=${reasoningEffort ?? 'unset'} ` +
      `mode=${MODE} runs=${RUNS}`,
  );
  console.error(`prompt: ${PROMPT}\n`);

  const results: RunResult[] = [];

  if (MODE === 'warm') {
    const client = makeClient();
    await client.connect();
    for (let i = 0; i < RUNS; i++) {
      const r = await measureOneResponse(client);
      results.push(r);
      console.log(fmt(r, i));
    }
    client.close();
  } else {
    // cold: a fresh socket (full TLS + session.update handshake) per run.
    for (let i = 0; i < RUNS; i++) {
      const client = makeClient();
      await client.connect();
      const r = await measureOneResponse(client);
      results.push(r);
      console.log(fmt(r, i));
      client.close();
      // Small breather so the socket fully tears down between cold runs.
      await new Promise((res) => setTimeout(res, 500));
    }
  }

  const rates = results.map((r) => r.rate);
  const min = Math.min(...rates);
  const max = Math.max(...rates);
  const avg = rates.reduce((a, b) => a + b, 0) / rates.length;
  const slow = results.filter((r) => r.rate < 1.0).length;
  console.log(
    `\nsummary: rate min=${min.toFixed(2)} avg=${avg.toFixed(2)} max=${max.toFixed(2)} | ` +
      `${slow}/${results.length} runs below real time`,
  );
  if (results.length > 0 && results[0].transcript !== '') {
    console.log(`last transcript: ${results[results.length - 1].transcript}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
