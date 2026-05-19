import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { StreamingMic } from '../../audio/streamingMic.ts';
import { ResponseSpeaker } from '../../realtime/responseSpeaker.ts';
import {
  RealtimeSession,
  type RealtimeSocket,
  type WsFactory,
} from '../../realtime/realtimeSession.ts';
import { buildRealtimeTools, dispatchRealtimeTool } from '../../realtime/toolDispatch.ts';
import type { McpClient } from '../../mcp/types.ts';
import type { MemoryStore } from '../../memory/types.ts';
import type { TelegramSender } from '../../telegram/types.ts';
import { createLogger } from '../../utils/logger.ts';

const log = createLogger('voice-realtime');

const MIC_SAMPLE_RATE = 24_000;
const MIC_FRAME_LENGTH = 1920; // 80ms @ 24kHz
const SPEAKER_SAMPLE_RATE = 24_000;
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
  wsFactory?: WsFactory;
  /** Override for tests. */
  micFactory?: () => MicLike;
  /** Override for tests. */
  speakerFactory?: () => SpeakerLike;
  /** Override for tests. Default uses node:readline. */
  prompt?: (msg: string) => Promise<void>;
}

export type { RealtimeSocket };

export interface MicLike {
  start(): void;
  stop(): void;
  onFrame(cb: (frame: Int16Array) => void): () => void;
}

export interface SpeakerLike {
  write(chunk: Buffer): void;
  done(): Promise<void>;
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

  const mic = (deps.micFactory ?? defaultMicFactory)();
  const makeSpeaker = deps.speakerFactory ?? defaultSpeakerFactory;
  const speakerRef: { current: SpeakerLike | null } = { current: null };

  const pendingFunctionCalls = new Map<string, FunctionCallItem>();
  let speechStoppedResolve: (() => void) | null = null;
  let responseDoneResolve: (() => void) | null = null;

  const session = new RealtimeSession({
    url: `${REALTIME_URL_BASE}?model=${encodeURIComponent(deps.model)}`,
    apiKey: deps.apiKey,
    wsFactory: deps.wsFactory,
    sessionUpdate: () => ({
      type: 'realtime',
      model: deps.model,
      instructions: deps.systemPrompt,
      tools,
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: MIC_SAMPLE_RATE },
          turn_detection: {
            type: 'server_vad',
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 600,
            create_response: true,
            interrupt_response: false,
          },
          // Input audio transcription is billed extra (~$0.006/min via
          // whisper-1) — only enable it when debugging.
          ...(isDebug() ? { transcription: { model: 'whisper-1' } } : {}),
        },
        output: {
          format: { type: 'audio/pcm', rate: SPEAKER_SAMPLE_RATE },
          voice: deps.voice ?? 'alloy',
        },
      },
    }),
    onEvent: (ev) => {
      void handleEvent(ev).catch((err) => log.error({ err }, 'event handler threw'));
    },
  });

  const handleEvent = async (ev: Record<string, unknown>): Promise<void> => {
    const type = typeof ev.type === 'string' ? ev.type : '';
    switch (type) {
      case '__opened':
        pendingFunctionCalls.clear();
        return;
      case 'response.output_audio.delta': {
        const b64 = typeof ev.delta === 'string' ? ev.delta : '';
        if (b64) {
          if (!speakerRef.current) {
            speakerRef.current = makeSpeaker();
          }
          speakerRef.current.write(Buffer.from(b64, 'base64'));
        }
        return;
      }
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
      case 'input_audio_buffer.speech_stopped': {
        speechStoppedResolve?.();
        speechStoppedResolve = null;
        return;
      }
      case 'response.output_item.done': {
        const item = parseFunctionCallItem(ev.item);
        if (item) {
          pendingFunctionCalls.set(item.call_id, item);
        }
        return;
      }
      case 'response.done': {
        const calls = [...pendingFunctionCalls.values()];
        pendingFunctionCalls.clear();
        if (calls.length === 0) {
          const finishing = speakerRef.current;
          speakerRef.current = null;
          if (finishing) {
            await finishing.done();
          }
          responseDoneResolve?.();
          responseDoneResolve = null;
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
          session.send({
            type: 'conversation.item.create',
            item: {
              type: 'function_call_output',
              call_id: call.call_id,
              output: result.isError ? `ERROR: ${result.output}` : result.output,
            },
          });
        }
        session.send({ type: 'response.create' });
        return;
      }
      case 'error': {
        log.error({ error: ev.error }, 'realtime error event');
        return;
      }
    }
  };

  log.info({ model: deps.model, tools: tools.length }, 'realtime runner ready');

  const rl = readline.createInterface({ input, output });
  const promptOnce = deps.prompt ?? ((m: string): Promise<void> => rl.question(m).then(() => {}));

  console.log(
    'Voice realtime. Press Enter to start talking; the server VAD stops the turn automatically. Ctrl+C to quit.',
  );

  try {
    while (true) {
      await promptOnce('Press Enter to talk... ');
      try {
        await session.ensureOpen();
      } catch (err) {
        log.error({ err }, 'failed to open realtime session');
        continue;
      }
      const speechStopped = new Promise<void>((resolve) => {
        speechStoppedResolve = resolve;
      });
      const responseDone = new Promise<void>((resolve) => {
        responseDoneResolve = resolve;
      });
      mic.start();
      const removeListener = mic.onFrame((frame) => {
        const b64 = int16ArrayToBase64(frame);
        session.send({ type: 'input_audio_buffer.append', audio: b64 });
      });
      await speechStopped;
      removeListener();
      mic.stop();
      console.log('(processing...)');
      await responseDone;
    }
  } finally {
    rl.close();
    speakerRef.current?.stop();
    session.close();
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

function isDebug(): boolean {
  const lvl = (process.env.LOG_LEVEL ?? '').toLowerCase();
  return lvl === 'debug' || lvl === 'trace';
}

function defaultMicFactory(): MicLike {
  return new StreamingMic({ sampleRate: MIC_SAMPLE_RATE, frameLength: MIC_FRAME_LENGTH });
}

function defaultSpeakerFactory(): SpeakerLike {
  return new ResponseSpeaker(SPEAKER_SAMPLE_RATE);
}
