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
  // Tracks an in-flight request_follow_up window so we can tell the
  // difference (in logs) between "user answered the model's question
  // within the window" and "window expired in silence". The device's
  // follow-up state is hidden from us — we approximate by running a
  // timer that matches the device's kFollowupOpenDelayMs (1500ms) +
  // kRequestFollowUpMs (10000ms) + a small slack so the log fires
  // *just after* the device-side timeout if no speech_started came in.
  private pendingFollowUp: { sentAt: number; timer: NodeJS.Timeout } | null = null;
  private static readonly FOLLOW_UP_WINDOW_MS = 12_000;

  // OpenAI Realtime caps every session at 30 minutes, so the upstream WS
  // *will* close on us on a long-lived device connection. We don't try to
  // hold it open with pings (the cap is hard) and we don't tear down the
  // device on every close (that wastes a reconnect cycle). Instead we lazy-
  // reconnect: the upstream stays disconnected until the device's next wake
  // word brings in a fresh audio frame, at which point we kick off
  // openai.connect() and buffer until it's ready. The wake-word UX gives us
  // ~1.1s of headroom (wake chime + i2s tail before mic streams), well over
  // a typical 300–500 ms connect, so the buffer barely fills in practice.
  private openaiState: 'disconnected' | 'connecting' | 'connected' = 'disconnected';
  private pendingConnect: Promise<void> | null = null;
  private audioBuffer: string[] = [];
  // Cap on how many base64 audio frames we'll buffer waiting for openai to
  // come up. ~50 fps × 4 s = 200 frames; beyond that we drop oldest to bound
  // memory if the connect hangs.
  private static readonly MAX_AUDIO_BUFFER_FRAMES = 200;

  constructor(deviceWs: WebSocket, deps: BridgeDeps) {
    this.deviceWs = deviceWs;
    this.deps = deps;
    // Inject two built-in flow-control tools ahead of MCP tools:
    //   - wait_for_user: incoming audio is silence/noise/echo; stay silent.
    //   - request_follow_up: model asked the user a clarifying question and
    //     wants them to answer without saying a wake word again. The bridge
    //     opens a follow-up mic window on the device.
    // By default the device closes the mic after every reply (XMOS AEC is
    // too leaky to hold the window open speculatively), so request_follow_up
    // is the *only* way to chain a turn without a wake word.
    const toolsWithWait: RealtimeTool[] = [
      {
        type: 'function',
        name: 'wait_for_user',
        description:
          'Call this when the latest audio does not need a spoken response: ' +
          'silence, background noise, the device hearing its own previous reply, ' +
          'side conversation, or speech not addressed to the assistant. Use it ' +
          'instead of saying "I did not catch that".',
        parameters: { type: 'object', properties: {}, required: [] },
      },
      {
        type: 'function',
        name: 'request_follow_up',
        description:
          'Call this immediately after speaking a question or clarification ' +
          'request to the user, so they can answer without saying a wake word ' +
          'again. The device will keep its microphone open for a few seconds ' +
          'after your reply. Only call this when you actually expect the user ' +
          'to respond; never call it after a statement that does not invite a ' +
          'reply.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
      ...deps.tools,
    ];
    this.openai = new OpenAiRealtimeClient({
      apiKey: deps.apiKey,
      model: deps.model,
      instructions: deps.instructions,
      voice: deps.voice,
      tools: toolsWithWait,
      reasoningEffort: deps.reasoningEffort,
    });
  }

  async start(): Promise<void> {
    this.metrics.mark('bridge_start');

    // Register the event + close listeners ONCE on the openai client.
    // Listener arrays inside OpenAiRealtimeClient persist across reconnects,
    // so a single subscription here keeps working when the underlying ws
    // gets swapped on lazy reconnect.
    this.openai.on((ev) => this.handleOpenAi(ev));
    this.openai.onClose((info) => {
      log.info(
        { sessionId: this.sessionId, code: info.code, reason: info.reason },
        'openai closed — will lazy-reconnect on next device audio',
      );
      this.openaiState = 'disconnected';
      // Drop any in-flight follow-up watchdog: if we were mid-window when
      // the upstream went away, there's nothing to wait for.
      this.clearFollowUpWatchdog();
    });

    await this.ensureOpenaiConnected();
    this.metrics.mark('openai_connected');

    this.deviceWs.on('message', (data, isBinary) => this.handleDevice(data, isBinary));
    this.deviceWs.on('close', () => {
      log.info({ sessionId: this.sessionId }, 'device closed');
      this.clearFollowUpWatchdog();
      this.metrics.log(this.sessionId);
      this.openai.close();
    });

    this.sendDevice({ type: 'hello', audioOut: 'pcm' });
    this.setPhase('idle', { force: true });
  }

  /**
   * Idempotent, concurrency-safe upstream connect. Returns immediately if
   * we're already connected; awaits an in-flight connect if one's running;
   * otherwise kicks off a new connect, marks state=connecting, and on
   * success drains any frames that piled up while we were down.
   */
  private async ensureOpenaiConnected(): Promise<void> {
    if (this.openaiState === 'connected') {
      return;
    }
    if (this.pendingConnect !== null) {
      return this.pendingConnect;
    }
    this.openaiState = 'connecting';
    const t0 = Date.now();
    this.pendingConnect = (async () => {
      try {
        await this.openai.connect();
        const tookMs = Date.now() - t0;
        log.info(
          { sessionId: this.sessionId, tookMs, buffered: this.audioBuffer.length },
          `openai reconnected in ${tookMs}ms`,
        );
        this.openaiState = 'connected';
        // Drain anything that arrived while we were connecting.
        for (const b64 of this.audioBuffer) {
          this.openai.appendAudioPcm16Base64(b64);
        }
        this.audioBuffer = [];
      } catch (err) {
        this.openaiState = 'disconnected';
        this.audioBuffer = [];
        log.error({ err, sessionId: this.sessionId }, 'openai connect failed');
        throw err;
      } finally {
        this.pendingConnect = null;
      }
    })();
    return this.pendingConnect;
  }

  private handleDevice(data: WebSocket.RawData, isBinary: boolean): void {
    // Belt-and-suspenders: any throw inside the ws message handler that
    // escapes will crash the whole process (Node's default unhandled-error
    // behaviour for EventEmitter). We've been bitten by this exactly once
    // when the OpenAI WS closed mid-session and an audio frame's send()
    // threw — entire container died. Swallow + log instead.
    try {
      this.handleDeviceInner(data, isBinary);
    } catch (err) {
      log.error({ err, sessionId: this.sessionId }, 'unhandled error in device handler');
    }
  }

  private handleDeviceInner(data: WebSocket.RawData, isBinary: boolean): void {
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
      const b64 = pcm16ToBase64(pcm24k);
      if (this.openaiState === 'connected') {
        // Fast path. appendAudioPcm16Base64 won't throw even if the ws
        // raced a close — drops the frame and logs a summary count.
        this.openai.appendAudioPcm16Base64(b64);
      } else {
        // OpenAI side is down (either initial connect failed or 30-min
        // cap expired mid-idle). Buffer this frame and kick a reconnect.
        // The wake-chime delay on the device gives us ~1.1 s before the
        // mic actually streams the user's voice, comfortably more than
        // a typical 300–500 ms openai connect.
        if (this.audioBuffer.length >= RealtimeBridge.MAX_AUDIO_BUFFER_FRAMES) {
          this.audioBuffer.shift(); // drop oldest to bound memory
        }
        this.audioBuffer.push(b64);
        if (this.openaiState === 'disconnected') {
          void this.ensureOpenaiConnected().catch(() => {
            // ensureOpenaiConnected already logged + cleared the buffer.
          });
        }
      }
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
    // Same belt-and-suspenders as handleDevice: any throw here would
    // crash the process (Node's default for EventEmitter listener errors).
    // The risk surface is mostly the control-message paths inside
    // (cancelResponse / submitToolResult) that throw when the openai ws
    // races a close. Lazy-reconnect makes that race rarer but not zero.
    try {
      this.handleOpenAiInner(ev);
    } catch (err) {
      log.error(
        { err, sessionId: this.sessionId, evType: ev.type },
        'unhandled error in openai handler',
      );
    }
  }

  private handleOpenAiInner(ev: RealtimeEvent): void {
    switch (ev.type) {
      case 'input_audio_buffer.speech_started':
        this.notePossibleFollowUpResponse();
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
        // Empty / single-non-letter transcripts are whisper hallucinating
        // from a brief noise burst (speaker-amp click, knob click, a stray
        // glottal sound). We've seen "뿅!", "...", single punctuation, etc.
        // Treat anything without at least one letter/digit character as noise.
        const hasLetterOrDigit = /\p{L}|\p{N}/u.test(cleaned);
        if (cleaned.length === 0 || !hasLetterOrDigit) {
          log.info(
            { transcript },
            'user transcript looks like noise — cancelling in-flight response',
          );
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
        // Pull out the error code/message defensively — the Realtime API
        // doesn't strictly type these.
        let code = '';
        let message = 'unknown';
        if (typeof ev.error === 'object' && ev.error !== null) {
          if ('code' in ev.error && typeof ev.error['code'] === 'string') {
            code = ev.error['code'];
          }
          if ('message' in ev.error && typeof ev.error['message'] === 'string') {
            message = ev.error['message'];
          }
        }
        // response_cancel_not_active is benign and noisy: we race
        // cancelResponse() against natural response completion (the
        // noise-transcript guard fires after the response has already
        // finished). Don't bother the device with an error chime — log
        // at debug for diagnostics and move on.
        if (code === 'response_cancel_not_active') {
          log.debug({ ev }, 'cancel raced with response completion (benign)');
          break;
        }
        log.error({ ev }, 'openai realtime error');
        this.sendDevice({ type: 'error', message });
        break;
      }
    }
  }

  private async handleToolCall(callId: string, name: string, argsJson: string): Promise<void> {
    // Built-in wait_for_user: model decided the audio doesn't warrant a
    // spoken reply. Acknowledge the tool call so the conversation state
    // stays valid, but DO NOT request a new response — the device should
    // just keep listening. End the LED replying/thinking phase manually
    // because the server isn't going to emit a clean response.done.
    if (name === 'wait_for_user') {
      log.info('wait_for_user — staying silent, no response triggered');
      this.openai.submitToolResult(callId, '{}', /* triggerResponse */ false);
      this.setPhase('idle');
      return;
    }
    // Built-in request_follow_up: model asked a question and wants the user
    // to answer without saying a wake word. Tell the device to open its
    // follow-up mic window, then close out the LED phase cleanly.
    if (name === 'request_follow_up') {
      log.info('request_follow_up — opening device follow-up mic window');
      this.openai.submitToolResult(callId, '{}', /* triggerResponse */ false);
      this.sendDevice({ type: 'request_follow_up' });
      this.setPhase('idle');
      this.armFollowUpWatchdog();
      return;
    }
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

  /**
   * Start a soft timeout matched to the device's follow-up window so we can
   * log when nothing came back. The bridge doesn't get an explicit signal
   * for "device closed the mic" — speech_started would arrive *only* if the
   * user actually answered, and silence == no event at all. Without this
   * timer there would be no log line that says "the user ignored the
   * model's question," which makes "why didn't the assistant act on the
   * follow-up?" much harder to debug.
   */
  private armFollowUpWatchdog(): void {
    this.clearFollowUpWatchdog();
    const sentAt = Date.now();
    const timer = setTimeout(() => {
      log.info(
        { sessionId: this.sessionId, windowMs: RealtimeBridge.FOLLOW_UP_WINDOW_MS },
        'request_follow_up window expired — user did not respond',
      );
      this.pendingFollowUp = null;
    }, RealtimeBridge.FOLLOW_UP_WINDOW_MS);
    // Don't keep the event loop alive solely for this timer.
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
    this.pendingFollowUp = { sentAt, timer };
  }

  /** Called on input_audio_buffer.speech_started — if we were waiting on a
   * request_follow_up reply, this is it. Cancel the watchdog so the
   * "expired" line doesn't also fire. */
  private notePossibleFollowUpResponse(): void {
    if (this.pendingFollowUp === null) {
      return;
    }
    const latencyMs = Date.now() - this.pendingFollowUp.sentAt;
    log.info(
      { sessionId: this.sessionId, latencyMs },
      `request_follow_up — user responded after ${latencyMs}ms`,
    );
    this.clearFollowUpWatchdog();
  }

  private clearFollowUpWatchdog(): void {
    if (this.pendingFollowUp === null) {
      return;
    }
    clearTimeout(this.pendingFollowUp.timer);
    this.pendingFollowUp = null;
  }
}
