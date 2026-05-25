import type WebSocket from 'ws';
import { createLogger } from '../utils/logger.ts';
import {
  OpenAiRealtimeClient,
  type RealtimeEvent,
  type ReasoningEffort,
} from './openaiRealtimeClient.ts';
import { resamplePcm16 } from './audio/resample.ts';
import { pcm16ToBase64, base64ToPcm16 } from './audio/format.ts';
import { encodeServerMessage, parseDeviceMessage, type ServerMessage } from './protocol.ts';
import { LatencyTracker } from './metrics.ts';
import type { RealtimeTool } from './toolAdapter.ts';

const log = createLogger('realtime-bridge');

function truncatePreview(value: unknown): string {
  let s: string;
  if (typeof value === 'string') {
    s = value;
  } else {
    try {
      s = JSON.stringify(value);
    } catch {
      s = String(value);
    }
  }
  return s.length > 200 ? s.slice(0, 200) + '…' : s;
}

export interface BridgeDeps {
  apiKey: string;
  model: string;
  instructions: string;
  voice: string;
  tools: RealtimeTool[];
  runTool: (name: string, args: unknown) => Promise<string>;
  reasoningEffort?: ReasoningEffort;
}

export class RealtimeBridge {
  private openai: OpenAiRealtimeClient;
  private metrics = new LatencyTracker();
  private sessionId = Math.random().toString(36).slice(2, 10);
  private deviceWs: WebSocket;
  private deps: BridgeDeps;
  private currentPhase: 'idle' | 'listening' | 'thinking' | 'replying' = 'idle';

  constructor(deviceWs: WebSocket, deps: BridgeDeps) {
    this.deviceWs = deviceWs;
    this.deps = deps;
    this.openai = new OpenAiRealtimeClient({
      apiKey: deps.apiKey,
      model: deps.model,
      instructions: deps.instructions,
      voice: deps.voice,
      tools: deps.tools,
      reasoningEffort: deps.reasoningEffort,
    });
  }

  async start(): Promise<void> {
    this.metrics.mark('bridge_start');
    await this.openai.connect();
    this.metrics.mark('openai_connected');

    this.openai.on((ev) => this.handleOpenAi(ev));

    this.deviceWs.on('message', (data, isBinary) => this.handleDevice(data, isBinary));
    this.deviceWs.on('close', () => {
      log.info({ sessionId: this.sessionId }, 'device closed');
      this.metrics.log(this.sessionId);
      this.openai.close();
    });

    this.sendDevice({ type: 'hello', audioOut: 'pcm' });
    this.setPhase('idle', { force: true });
  }

  private handleDevice(data: WebSocket.RawData, isBinary: boolean): void {
    if (isBinary) {
      this.metrics.mark('first_audio_in');
      // Device sends PCM16 16kHz; OpenAI Realtime expects PCM16 24kHz.
      let pcm16k: Buffer;
      if (Buffer.isBuffer(data)) {
        pcm16k = data;
      } else if (data instanceof ArrayBuffer) {
        pcm16k = Buffer.from(data);
      } else {
        // data is Buffer[] - concatenate them
        pcm16k = Buffer.concat(data);
      }
      const pcm24k = resamplePcm16(pcm16k, 16000, 24000);
      this.openai.appendAudioPcm16Base64(pcm16ToBase64(pcm24k));
      return;
    }
    try {
      const msg = parseDeviceMessage(data.toString());
      log.debug({ msg }, 'device control msg');
      if (msg.type === 'interrupt') {
        this.openai.cancelResponse();
        this.setPhase('listening');
      } else if (msg.type === 'ping') {
        this.sendDevice({ type: 'pong' });
      }
    } catch (err) {
      log.warn({ err }, 'bad device control message');
    }
  }

  private handleOpenAi(ev: RealtimeEvent): void {
    switch (ev.type) {
      case 'input_audio_buffer.speech_started':
        this.setPhase('listening');
        break;
      case 'input_audio_buffer.speech_stopped':
        // Server VAD detected end-of-speech. Eagerly enter "thinking"
        // before response.created so the LED reflects intent without a
        // gap. We stay in this phase through any tool-call cycles.
        this.metrics.mark('thinking_started');
        this.setPhase('thinking');
        break;
      case 'conversation.item.input_audio_transcription.completed': {
        const transcript =
          'transcript' in ev && typeof ev.transcript === 'string' ? ev.transcript : '';
        log.info(`user → ${transcript}`);
        // Empty / near-empty transcript means whisper heard noise or the
        // device's own TTS tail. Realtime fires a response in parallel
        // with transcription, so by the time we know it's empty the model
        // is already saying "I didn't catch that". Cancel it to keep the
        // device quiet rather than spawning a useless turn.
        const cleaned = transcript.trim();
        if (cleaned.length === 0 || cleaned === '.' || cleaned === '…') {
          log.info('user transcript is empty — cancelling in-flight response');
          try {
            this.openai.cancelResponse();
          } catch (err) {
            log.warn({ err }, 'failed to cancel empty-input response');
          }
        }
        break;
      }
      case 'response.output_audio_transcript.done': {
        const transcript =
          'transcript' in ev && typeof ev.transcript === 'string' ? ev.transcript : '';
        log.info(`assistant → ${transcript}`);
        break;
      }
      case 'response.output_audio.delta': {
        this.metrics.mark('first_audio_out');
        if (typeof ev.delta === 'string') {
          const pcm24k = base64ToPcm16(ev.delta);
          this.deviceWs.send(pcm24k, { binary: true });
          this.setPhase('replying');
        }
        break;
      }
      case 'response.function_call_arguments.done': {
        if (
          typeof ev.call_id === 'string' &&
          typeof ev.name === 'string' &&
          typeof ev.arguments === 'string'
        ) {
          void this.handleToolCall(ev.call_id, ev.name, ev.arguments);
        }
        break;
      }
      case 'response.done': {
        // If this response.done contains ANY function_call output, the model
        // is going to need our tool result and then emit another response.
        // Don't drop to idle yet — the device would close its replying phase,
        // open the follow-up mic window, and pick up the next TTS chunks as
        // "user speech" through the imperfect AEC. This covers both cases:
        //  1) Pure tool-call response (no audio) — original concern.
        //  2) Mixed response where the model speaks then calls a tool, e.g.
        //     "Okay, turning off the kitchen light" followed by HassTurnOff.
        const response: unknown = 'response' in ev ? ev.response : undefined;
        const output =
          typeof response === 'object' &&
          response !== null &&
          'output' in response &&
          Array.isArray(response.output)
            ? response.output
            : [];
        const hasToolCall = output.some((item: unknown) => {
          if (typeof item !== 'object' || item === null || !('type' in item)) {
            return false;
          }
          return item.type === 'function_call';
        });
        if (!hasToolCall) {
          this.setPhase('idle');
        }
        break;
      }
      case 'error': {
        log.error({ ev }, 'openai realtime error');
        let message = 'unknown';
        if (typeof ev.error === 'object' && ev.error !== null && 'message' in ev.error) {
          const msg = ev.error['message'];
          if (typeof msg === 'string') {
            message = msg;
          }
        }
        this.sendDevice({ type: 'error', message });
        break;
      }
    }
  }

  private async handleToolCall(callId: string, name: string, argsJson: string): Promise<void> {
    const t0 = Date.now();
    let args: unknown;
    try {
      args = JSON.parse(argsJson);
    } catch {
      args = argsJson;
    }
    try {
      const result = await this.deps.runTool(name, args);
      const durationMs = Date.now() - t0;
      const truncatedResult = result.length > 500 ? result.slice(0, 500) + '…' : result;
      log.info(
        { name, callId, args, durationMs },
        `${name}(${truncatePreview(args)}) → ${truncatedResult} (${durationMs}ms)`,
      );
      this.openai.submitToolResult(callId, result);
    } catch (err) {
      const durationMs = Date.now() - t0;
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.warn(
        { name, callId, args, durationMs, err },
        `${name}(${truncatePreview(args)}) FAILED in ${durationMs}ms: ${errorMsg}`,
      );
      this.openai.submitToolResult(callId, JSON.stringify({ error: errorMsg }));
    }
  }

  private sendDevice(msg: ServerMessage): void {
    this.deviceWs.send(encodeServerMessage(msg));
  }

  /** Update the phase LED on the device. Dedupes — repeated same-phase
   * messages are suppressed so the device doesn't flicker. Pass
   * `force: true` for the initial hello to make sure the device sees the
   * starting state even if we haven't transitioned yet. */
  private setPhase(
    next: 'idle' | 'listening' | 'thinking' | 'replying',
    opts: { force?: boolean } = {},
  ): void {
    if (!opts.force && this.currentPhase === next) {
      return;
    }
    this.currentPhase = next;
    this.sendDevice({ type: 'phase', value: next });
  }
}
