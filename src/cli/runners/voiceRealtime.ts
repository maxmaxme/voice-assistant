import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import WebSocket from 'ws';
import { StreamingMic } from '../../audio/streamingMic.ts';
import { NodeSpeakerOutput } from '../../audio/speakerOutput.ts';
import { AudioChunkQueue } from '../../realtime/audioQueue.ts';
import { buildRealtimeTools, dispatchRealtimeTool } from '../../realtime/toolDispatch.ts';
import type { McpClient } from '../../mcp/types.ts';
import type { MemoryStore } from '../../memory/types.ts';
import type { TelegramSender } from '../../telegram/types.ts';
import { createLogger } from '../../utils/logger.ts';

const log = createLogger('voice-realtime');

const MIC_SAMPLE_RATE = 24000;
const MIC_FRAME_LENGTH = 1920; // 80ms @ 24kHz
const SPEAKER_SAMPLE_RATE = 24000;
const REALTIME_URL_BASE = 'wss://api.openai.com/v1/realtime';

export interface VoiceRealtimeRunnerDeps {
  apiKey: string;
  model: string;
  systemPrompt: string;
  mcp: McpClient;
  memory: MemoryStore;
  telegram: TelegramSender;
  voice?: string;
  /** Override for tests. Default opens a real WS to OpenAI. */
  wsFactory?: (url: string, apiKey: string) => RealtimeSocket;
  /** Override for tests. */
  micFactory?: () => MicLike;
  /** Override for tests. */
  speakerFactory?: () => SpeakerLike;
  /** Override for tests. Default uses node:readline. */
  prompt?: (msg: string) => Promise<void>;
}

/** Minimal contract over `ws.WebSocket` so tests can mock it. */
export interface RealtimeSocket {
  send(data: string): void;
  close(): void;
  on(event: 'open', cb: () => void): void;
  on(event: 'message', cb: (data: Buffer | string) => void): void;
  on(event: 'close', cb: () => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
}

export interface MicLike {
  start(): void;
  stop(): void;
  onFrame(cb: (frame: Int16Array) => void): () => void;
}

export interface SpeakerLike {
  playStream(s: { chunks: AsyncIterable<Buffer>; sampleRate: number }): Promise<void>;
  stop(): void;
}

interface FunctionCallItem {
  type: 'function_call';
  call_id: string;
  name: string;
  arguments: string;
}

export async function runVoiceRealtimeMode(deps: VoiceRealtimeRunnerDeps): Promise<void> {
  const tools = await buildRealtimeTools({
    mcp: deps.mcp,
    memory: deps.memory,
    telegram: deps.telegram,
  });

  const url = `${REALTIME_URL_BASE}?model=${encodeURIComponent(deps.model)}`;
  const ws = (deps.wsFactory ?? defaultWsFactory)(url, deps.apiKey);
  const mic = (deps.micFactory ?? defaultMicFactory)();
  const speaker = (deps.speakerFactory ?? defaultSpeakerFactory)();

  await waitForOpen(ws);
  log.info({ model: deps.model, tools: tools.length }, 'realtime ws open');

  ws.send(
    JSON.stringify({
      type: 'session.update',
      session: {
        type: 'realtime',
        model: deps.model,
        instructions: deps.systemPrompt,
        tools,
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: MIC_SAMPLE_RATE },
            turn_detection: null,
          },
          output: {
            format: { type: 'audio/pcm', rate: SPEAKER_SAMPLE_RATE },
            voice: deps.voice ?? 'alloy',
          },
        },
      },
    }),
  );

  let audioQueue: AudioChunkQueue | null = null;
  let playPromise: Promise<void> | null = null;
  const pendingFunctionCalls = new Map<string, FunctionCallItem>();

  const startPlayback = (): void => {
    if (audioQueue && playPromise) {
      return;
    }
    audioQueue = new AudioChunkQueue();
    playPromise = speaker
      .playStream({ chunks: audioQueue, sampleRate: SPEAKER_SAMPLE_RATE })
      .catch((err: unknown) => {
        log.warn({ err }, 'speaker playback error');
      });
  };

  const endPlayback = (): void => {
    audioQueue?.end();
    audioQueue = null;
    playPromise = null;
  };

  const handleEvent = async (ev: Record<string, unknown>): Promise<void> => {
    const type = typeof ev.type === 'string' ? ev.type : '';
    switch (type) {
      case 'response.output_audio.delta': {
        const b64 = typeof ev.delta === 'string' ? ev.delta : '';
        if (!b64) {
          return;
        }
        startPlayback();
        audioQueue?.push(Buffer.from(b64, 'base64'));
        return;
      }
      case 'response.output_audio.done':
        endPlayback();
        return;
      case 'response.output_audio_transcript.done': {
        const t = typeof ev.transcript === 'string' ? ev.transcript : '';
        if (t) {
          console.log(`Assistant: ${t}`);
        }
        return;
      }
      case 'conversation.item.input_audio_transcription.completed': {
        const t = typeof ev.transcript === 'string' ? ev.transcript : '';
        if (t) {
          console.log(`User: ${t}`);
        }
        return;
      }
      case 'response.output_item.added':
      case 'response.output_item.done': {
        const item = parseFunctionCallItem(ev.item);
        if (item && type === 'response.output_item.done') {
          pendingFunctionCalls.set(item.call_id, item);
        }
        return;
      }
      case 'response.done': {
        endPlayback();
        const calls = [...pendingFunctionCalls.values()];
        pendingFunctionCalls.clear();
        if (calls.length === 0) {
          return;
        }
        for (const call of calls) {
          const args = safeParseArgs(call.arguments);
          const result = await dispatchRealtimeTool(
            { mcp: deps.mcp, memory: deps.memory, telegram: deps.telegram },
            call.name,
            args,
          );
          log.debug(
            { tool: call.name, args, isError: result.isError },
            `${call.name}(${JSON.stringify(args)}) → ${result.output}`,
          );
          ws.send(
            JSON.stringify({
              type: 'conversation.item.create',
              item: {
                type: 'function_call_output',
                call_id: call.call_id,
                output: result.isError ? `ERROR: ${result.output}` : result.output,
              },
            }),
          );
        }
        ws.send(JSON.stringify({ type: 'response.create' }));
        return;
      }
      case 'error': {
        log.error({ error: ev.error }, 'realtime error event');
        return;
      }
    }
  };

  ws.on('message', (data) => {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(typeof data === 'string' ? data : data.toString('utf8'));
    } catch (err) {
      log.warn({ err }, 'unparseable ws message');
      return;
    }
    void handleEvent(parsed).catch((err) => log.error({ err }, 'event handler threw'));
  });

  const rl = readline.createInterface({ input, output });
  const promptOnce = deps.prompt ?? ((m: string): Promise<void> => rl.question(m).then(() => {}));

  console.log(
    'Voice realtime push-to-talk. Press Enter to start streaming, Enter again to stop. Ctrl+C to quit.',
  );

  let closed = false;
  ws.on('close', () => {
    closed = true;
    rl.close();
  });
  ws.on('error', (err) => log.error({ err }, 'realtime ws error'));

  try {
    while (!closed) {
      await promptOnce('Press Enter to talk... ');
      if (closed) {
        break;
      }
      mic.start();
      const removeListener = mic.onFrame((frame) => {
        const b64 = int16ArrayToBase64(frame);
        ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: b64 }));
      });
      await promptOnce('Streaming. Press Enter when done. ');
      removeListener();
      mic.stop();
      ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
      ws.send(JSON.stringify({ type: 'response.create' }));
    }
  } finally {
    rl.close();
    speaker.stop();
    ws.close();
  }
}

function int16ArrayToBase64(frame: Int16Array): string {
  const buf = Buffer.alloc(frame.length * 2);
  for (let i = 0; i < frame.length; i++) {
    buf.writeInt16LE(frame[i]!, i * 2);
  }
  return buf.toString('base64');
}

function parseFunctionCallItem(raw: unknown): FunctionCallItem | null {
  if (!isRecord(raw)) {
    return null;
  }
  if (raw.type !== 'function_call') {
    return null;
  }
  const callId = raw.call_id;
  const name = raw.name;
  const args = raw.arguments;
  if (typeof callId !== 'string' || typeof name !== 'string' || typeof args !== 'string') {
    return null;
  }
  return { type: 'function_call', call_id: callId, name, arguments: args };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function safeParseArgs(raw: string | undefined): Record<string, unknown> {
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return {};
  }
}

function waitForOpen(ws: RealtimeSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', (err) => reject(err));
  });
}

function defaultWsFactory(url: string, apiKey: string): RealtimeSocket {
  const ws = new WebSocket(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  return {
    send: (data) => ws.send(data),
    close: () => ws.close(),
    on: (event, cb) => {
      ws.on(event, cb);
    },
  };
}

function defaultMicFactory(): MicLike {
  return new StreamingMic({ sampleRate: MIC_SAMPLE_RATE, frameLength: MIC_FRAME_LENGTH });
}

function defaultSpeakerFactory(): SpeakerLike {
  return new NodeSpeakerOutput();
}
