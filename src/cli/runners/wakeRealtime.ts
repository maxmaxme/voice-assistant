import { spawnSync } from 'node:child_process';
import WebSocket from 'ws';
import type { Config } from '../../config.ts';
import { StreamingMic } from '../../audio/streamingMic.ts';
import { OpenWakeWord } from '../../audio/wakeWord.ts';
import { SessionSpeaker } from '../../realtime/sessionSpeaker.ts';
import { buildRealtimeTools, dispatchRealtimeTool } from '../../realtime/toolDispatch.ts';
import type { McpClient } from '../../mcp/types.ts';
import type { MemoryStore } from '../../memory/types.ts';
import type { TelegramSender } from '../../telegram/types.ts';
import { createLogger } from '../../utils/logger.ts';

const log = createLogger('wake-realtime');

const WAKE_SAMPLE_RATE = 16_000;
const WAKE_FRAME_LENGTH = 1280; // 80ms @ 16kHz — fixed by openWakeWord
const REALTIME_SAMPLE_RATE = 24_000;
const REALTIME_FRAME_LENGTH = 1920; // 80ms @ 24kHz
const REALTIME_URL_BASE = 'wss://api.openai.com/v1/realtime';

export interface WakeRealtimeRunnerDeps {
  apiKey: string;
  model: string;
  systemPrompt: string;
  config: Config;
  mcp: McpClient;
  memory: MemoryStore;
  telegram: TelegramSender;
  voice?: string;
}

interface FunctionCallItem {
  type: 'function_call';
  call_id: string;
  name: string;
  arguments: string;
}

function hasCaptureDevice(): boolean {
  if (process.platform !== 'linux') {
    return true;
  }
  const result = spawnSync('arecord', ['-l'], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    return false;
  }
  return /^card \d+:/m.test(result.stdout);
}

export async function runWakeRealtimeMode(deps: WakeRealtimeRunnerDeps): Promise<void> {
  if (!hasCaptureDevice()) {
    log.warn('no ALSA capture device detected; skipping wake-realtime runner');
    await new Promise<void>(() => {});
    return;
  }

  const tools = await buildRealtimeTools({
    mcp: deps.mcp,
    memory: deps.memory,
    telegram: deps.telegram,
  });

  const url = `${REALTIME_URL_BASE}?model=${encodeURIComponent(deps.model)}`;
  const ws = new WebSocket(url, {
    headers: { Authorization: `Bearer ${deps.apiKey}` },
  });
  const speaker = new SessionSpeaker(REALTIME_SAMPLE_RATE);

  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', (err) => reject(err));
  });
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
            format: { type: 'audio/pcm', rate: REALTIME_SAMPLE_RATE },
            turn_detection: {
              type: 'server_vad',
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 600,
              create_response: true,
              interrupt_response: false,
            },
            transcription: { model: 'whisper-1' },
          },
          output: {
            format: { type: 'audio/pcm', rate: REALTIME_SAMPLE_RATE },
            voice: deps.voice ?? 'alloy',
          },
        },
      },
    }),
  );

  speaker.start();
  const pendingFunctionCalls = new Map<string, FunctionCallItem>();

  // Two mics, used sequentially: wakeMic @ 16kHz feeds the wake-word daemon
  // while idle; realtimeMic @ 24kHz streams to the OpenAI session during a
  // turn. ALSA on Linux doesn't allow two simultaneous captures of the same
  // device, so we always stop one before starting the other.
  const wakeMic = new StreamingMic({
    sampleRate: WAKE_SAMPLE_RATE,
    frameLength: WAKE_FRAME_LENGTH,
  });
  const realtimeMic = new StreamingMic({
    sampleRate: REALTIME_SAMPLE_RATE,
    frameLength: REALTIME_FRAME_LENGTH,
  });
  const wake = new OpenWakeWord({
    pythonPath: deps.config.wakeWord.pythonPath,
    scriptPath: deps.config.wakeWord.scriptPath,
    keyword: deps.config.wakeWord.keyword,
    threshold: deps.config.wakeWord.threshold,
    debug: deps.config.wakeWord.debug,
  });
  await wake.start();

  type State = 'idle' | 'listening' | 'responding';
  let state: State = 'idle';

  let removeRealtimeListener: (() => void) | null = null;
  const stopRealtimeStream = (): void => {
    removeRealtimeListener?.();
    removeRealtimeListener = null;
    realtimeMic.stop();
  };

  const enterIdle = (): void => {
    state = 'idle';
    wakeMic.start();
  };

  const enterListening = (): void => {
    state = 'listening';
    wakeMic.stop();
    realtimeMic.start();
    removeRealtimeListener = realtimeMic.onFrame((frame) => {
      const b64 = int16ArrayToBase64(frame);
      ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: b64 }));
    });
  };

  wakeMic.onFrame((frame) => {
    if (state === 'idle') {
      wake.feed(frame);
    }
  });

  wake.onWake((keyword, score) => {
    if (state !== 'idle') {
      return;
    }
    log.info({ keyword, score }, `wake → ${keyword} (${score.toFixed(2)})`);
    enterListening();
  });

  const handleEvent = async (ev: Record<string, unknown>): Promise<void> => {
    const type = typeof ev.type === 'string' ? ev.type : '';
    switch (type) {
      case 'response.output_audio.delta': {
        const b64 = typeof ev.delta === 'string' ? ev.delta : '';
        if (b64) {
          speaker.write(Buffer.from(b64, 'base64'));
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
        if (state === 'listening') {
          state = 'responding';
          stopRealtimeStream();
        }
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
          if (state === 'responding') {
            enterIdle();
          }
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

  ws.on('message', (data: Buffer) => {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(data.toString('utf8'));
    } catch (err) {
      log.warn({ err }, 'unparseable ws message');
      return;
    }
    void handleEvent(parsed).catch((err) => log.error({ err }, 'event handler threw'));
  });

  ws.on('error', (err) => log.error({ err }, 'realtime ws error'));

  enterIdle();
  console.log(
    `Wake-realtime ready. Say "${deps.config.wakeWord.keyword}" to wake the assistant. Ctrl+C to quit.`,
  );

  // Block forever; runtime is event-driven from here.
  await new Promise<void>((resolve) => {
    ws.once('close', () => resolve());
  });

  stopRealtimeStream();
  wakeMic.stop();
  await wake.stop();
  speaker.stop();
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
