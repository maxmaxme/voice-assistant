import type WebSocket from 'ws';
import { createLogger } from '../utils/logger.ts';
import { OpenAiRealtimeClient, type ReasoningEffort } from './openaiRealtimeClient.ts';
import type { RealtimeServerEvent } from 'openai/resources/realtime/realtime';
import { resamplePcm16 } from './audio/resample.ts';
import { pcm16ToBase64, base64ToPcm16 } from './audio/format.ts';
import {
  encodeServerMessage,
  parseDeviceMessage,
  type Phase,
  type ServerMessage,
} from './protocol.ts';
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
  // How long to wait while the bridge is in `idle` phase before tearing
  // down the upstream OpenAI Realtime session so the next wake word gets
  // a fresh conversation. 0 disables the timer (legacy behaviour — the
  // session only resets on OpenAI's hard 30/60-minute cap).
  idleResetMs?: number;
}

export class RealtimeBridge {
  private openai: OpenAiRealtimeClient;
  private metrics = new LatencyTracker();
  private sessionId = Math.random().toString(36).slice(2, 10);
  private deviceWs: WebSocket;
  private deps: BridgeDeps;
  private currentPhase: Phase = 'idle';
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

  // Idle-reset: drops the upstream Realtime session after the bridge sits
  // in `idle` for `idleResetMs`, so the next wake word starts a fresh
  // conversation instead of resuming whatever was being discussed N
  // minutes ago. Pairs with lazy-reconnect — closing the upstream is
  // enough, the next audio frame will reopen it.
  private idleResetTimer: NodeJS.Timeout | null = null;
  private readonly idleResetMs: number;

  // Set on device-initiated interrupt. OpenAI's response.cancel is not
  // instantaneous — the server can still flush queued response.output_audio
  // deltas for the cancelled response after we asked it to stop. Without
  // dropping those, the device hears "the tail of the answer you just
  // barged through" (or, on a Stop wake word, a phantom continuation a
  // second later). We drop deltas until a fresh response.created arrives,
  // which marks the start of a genuinely new response.
  private dropResponseAudio = false;

  // Tool calls for the in-progress response. Each `function_call_arguments.done`
  // pushes the promise that runs the tool + submits its `function_call_output`.
  // `response.done` awaits this list and then fires ONE `response.create` —
  // submitting two response.create back-to-back is what produces
  // `conversation_already_has_active_response`.
  private pendingToolCalls: Promise<void>[] = [];

  constructor(deviceWs: WebSocket, deps: BridgeDeps) {
    this.deviceWs = deviceWs;
    this.deps = deps;
    this.idleResetMs = deps.idleResetMs ?? 0;
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
      // Drop pending tool-call promises — the response they belong to is
      // gone, and submitting their outputs to a fresh session would point
      // at unknown call ids.
      this.pendingToolCalls = [];
    });

    // Don't connect upstream here. Per the lazy-reconnect design above, the
    // OpenAI session stays down until the device's first audio frame — see
    // handleDeviceInner. Connecting eagerly on every WS attach (e.g. when the
    // speaker reconnects at boot) burns a session that just idles for
    // idleResetMs and then closes untouched.
    this.deviceWs.on('message', (data, isBinary) => this.handleDevice(data, isBinary));
    this.deviceWs.on('close', () => {
      log.info({ sessionId: this.sessionId }, 'device closed');
      this.clearFollowUpWatchdog();
      this.clearIdleResetTimer();
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
        this.metrics.mark('openai_connected');
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
      if (msg.type === 'start') {
        // Wake word fired on the device — a turn is beginning. This is the
        // *only* signal that opens a turn, including barge-in: the device no
        // longer pairs it with a separate `interrupt`. So `start` also has to
        // tear down any reply still in flight — cancel it upstream and drop
        // its tail audio (the new turn's response.created re-arms forwarding).
        // On a fresh wake there's nothing to cancel — cancelResponse is a
        // no-op on a lazily-disconnected upstream and benign when connected
        // with no active response (response_cancel_not_active). Going to listening
        // mirrors the device's local LED and clears the idle-reset timer so an
        // active turn can't be torn down mid-listen; speech_started later
        // re-asserts listening (deduped to a no-op).
        // A wake word during a follow-up window means the user re-engaged
        // (just via wake word rather than the open follow-up mic), so retire
        // the watchdog — otherwise it would later log a bogus "user did not
        // respond". No-op when no follow-up is pending.
        this.notePossibleFollowUpResponse();
        this.openai.cancelResponse();
        this.dropResponseAudio = true;
        this.setPhase('listening');
      } else if (msg.type === 'interrupt') {
        // Device is aborting the current turn and returning to idle — a Stop
        // wake word, or the no-speech watchdog. (Barge-in does NOT come here;
        // it sends `start`.) Cancel the response upstream and move the bridge
        // back to idle so the idle-reset timer re-arms — otherwise a turn
        // aborted from listening leaves the bridge stuck non-idle with the
        // OpenAI session leaking open forever. We go to idle, not listening:
        // setPhase('listening') used to live here and popped the mic open
        // after a Stop, which let OpenAI emit a phantom follow-up response.
        this.openai.cancelResponse();
        this.dropResponseAudio = true;
        this.setPhase('idle');
      } else if (msg.type === 'ping') {
        this.sendDevice({ type: 'pong' });
      }
    } catch (err) {
      log.warn({ err }, 'bad device control message');
    }
  }

  private handleOpenAi(ev: RealtimeServerEvent): void {
    // Same belt-and-suspenders as handleDevice: any throw here would
    // crash the process (Node's default for EventEmitter listener errors).
    // The risk surface is mostly the control-message paths inside
    // (cancelResponse / submitToolResult) that throw when the openai ws
    // races a close. Lazy-reconnect makes that race rarer but not zero.
    //
    // `handleOpenAiInner` is async only because response.done waits on
    // in-flight tool calls before requesting the next response — we still
    // return void here so the event listener stays fire-and-forget.
    this.handleOpenAiInner(ev).catch((err: unknown) => {
      log.error(
        { err, sessionId: this.sessionId, evType: ev.type },
        'unhandled error in openai handler',
      );
    });
  }

  private async handleOpenAiInner(ev: RealtimeServerEvent): Promise<void> {
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
        const transcript = ev.transcript.trim();
        log.info(`user → ${transcript}`);
        // Empty / single-non-letter transcripts are whisper hallucinating
        // from a brief noise burst (speaker-amp click, knob click, a stray
        // glottal sound). We've seen "뿅!", "...", single punctuation, etc.
        // Treat anything without at least one letter/digit character as noise.
        const hasLetterOrDigit = /\p{L}|\p{N}/u.test(transcript);
        if (transcript.length === 0 || !hasLetterOrDigit) {
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
        log.info(`assistant → ${ev.transcript}`);
        break;
      }
      case 'response.output_audio.delta': {
        // After a device interrupt, upstream may still flush queued audio
        // deltas for the cancelled response. Drop them — the device has
        // already stopped playback and reopened (or closed) the mic; we
        // mustn't push the old reply's tail back at it.
        if (this.dropResponseAudio) {
          break;
        }
        this.metrics.mark('first_audio_out');
        if (typeof ev.delta === 'string') {
          const pcm24k = base64ToPcm16(ev.delta);
          this.deviceWs.send(pcm24k, { binary: true });
          this.setPhase('replying');
        }
        break;
      }
      case 'response.created':
        // A fresh response is starting — clear the drop flag so its audio
        // deltas reach the device. Anything still queued from the previous
        // (cancelled) response has been ignored up to this point.
        this.dropResponseAudio = false;
        log.info({ responseId: ev.response.id, sessionId: this.sessionId }, 'response.created');
        break;
      case 'response.function_call_arguments.done': {
        if (
          typeof ev.call_id === 'string' &&
          typeof ev.name === 'string' &&
          typeof ev.arguments === 'string'
        ) {
          // Kick the tool off eagerly (don't wait for response.done) so
          // parallel MCP calls overlap. response.done will await the batch.
          this.pendingToolCalls.push(this.handleToolCall(ev.call_id, ev.name, ev.arguments));
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
        const output = ev.response.output ?? [];
        // "Real" = a function call whose output will feed back into a
        // follow-up response. The built-in flow-control tools (wait_for_user,
        // request_follow_up) deliberately do NOT trigger a follow-up, so
        // they must not keep the device in `thinking` and must not cause
        // us to fire response.create.
        const BUILTIN_FLOW_CONTROL = new Set(['wait_for_user', 'request_follow_up']);
        const hasRealToolCall = output.some(
          (item) => item.type === 'function_call' && !BUILTIN_FLOW_CONTROL.has(item.name),
        );
        const pending = this.pendingToolCalls;
        this.pendingToolCalls = [];
        const responseId = ev.response.id ?? '?';
        const outputKinds =
          output
            .map((item) =>
              item.type === 'function_call' ? `function_call(${item.name})` : item.type,
            )
            .join(',') || '<empty>';
        log.info(
          {
            responseId,
            outputKinds,
            hasRealToolCall,
            pendingCount: pending.length,
            sessionId: this.sessionId,
          },
          'response.done',
        );
        if (!hasRealToolCall) {
          // No follow-up response will be requested — drop back to idle, but
          // only if we're still in the turn this response.done belongs to
          // (thinking/replying). A barge-in `start` may have already cancelled
          // this response and opened a fresh turn (phase=listening); the late
          // response.done for the cancelled reply must not drag that new turn
          // back to idle. Builtin flow-control tools have already set their own
          // phase. This covers pure-text responses.
          if (this.currentPhase === 'thinking' || this.currentPhase === 'replying') {
            this.setPhase('idle');
          }
          break;
        }
        // Wait for every tool's output to be submitted, then ask the model
        // for its follow-up. One response.create per response — submitting
        // it per tool produces `conversation_already_has_active_response`.
        //
        // allSettled (not all): handleToolCall catches runTool failures and
        // submits an error result, but submitToolResult itself can still
        // throw on a closed upstream ws. If one tool rejects we still want
        // to request the follow-up — the model will see whichever outputs
        // did land and reply about the rest. Failing the whole batch would
        // strand the conversation in `thinking` with no way out.
        const results = await Promise.allSettled(pending);
        for (const r of results) {
          if (r.status === 'rejected') {
            log.warn({ err: r.reason }, 'tool call promise rejected — continuing batch');
          }
        }
        log.info(
          { responseId, sessionId: this.sessionId },
          'tool batch complete — requesting follow-up response',
        );
        this.openai.requestResponse();
        break;
      }
      case 'error': {
        const code = ev.error.code ?? 'unknown';
        const message = ev.error.message;
        // Some upstream errors are expected lifecycle events, not real
        // failures the user needs to know about. Don't surface them to
        // the device (which would fire the error chime + red LED) —
        // lazy-reconnect handles the recovery on the next wake word.
        //
        //  - response_cancel_not_active: noise-transcript guard called
        //    cancelResponse() after the response had already finished.
        //  - session_expired: OpenAI Realtime hits its hard session
        //    cap (30 / 60 minutes depending on the account). The 'close'
        //    event will follow immediately and we'll lazy-reconnect.
        const benignCodes = new Set(['response_cancel_not_active', 'session_expired']);
        if (benignCodes.has(code)) {
          log.info({ code, message }, `upstream sent ${code} (benign, suppressing device error)`);
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
      this.openai.submitToolResult(callId, '{}');
      this.setPhase('idle');
      return;
    }
    // Built-in request_follow_up: model asked a question and wants the user
    // to answer without saying a wake word. Tell the device to open its
    // follow-up mic window, then close out the LED phase cleanly.
    if (name === 'request_follow_up') {
      log.info('request_follow_up — opening device follow-up mic window');
      this.openai.submitToolResult(callId, '{}');
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
  private setPhase(next: Phase, opts: { force?: boolean } = {}): void {
    if (!opts.force && this.currentPhase === next) {
      return;
    }
    this.currentPhase = next;
    this.sendDevice({ type: 'phase', value: next });
    if (next === 'idle') {
      this.armIdleResetTimer();
    } else {
      this.clearIdleResetTimer();
    }
  }

  private armIdleResetTimer(): void {
    this.clearIdleResetTimer();
    if (this.idleResetMs <= 0) {
      return;
    }
    const timer = setTimeout(() => {
      this.idleResetTimer = null;
      if (this.openaiState !== 'connected') {
        return;
      }
      log.info(
        { sessionId: this.sessionId, idleResetMs: this.idleResetMs },
        'idle reset — closing upstream so next wake word starts a fresh conversation',
      );
      this.openai.close();
    }, this.idleResetMs);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
    this.idleResetTimer = timer;
  }

  private clearIdleResetTimer(): void {
    if (this.idleResetTimer === null) {
      return;
    }
    clearTimeout(this.idleResetTimer);
    this.idleResetTimer = null;
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
