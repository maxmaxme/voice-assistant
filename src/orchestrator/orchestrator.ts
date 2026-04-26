import type { Agent } from '../agent/types.ts';
import type { Stt, Tts, SpeakerOutput } from '../audio/types.ts';
import type { State, Event, Effect } from './types.ts';
import { transition } from './fsm.ts';
import { StreamingMic } from '../audio/streamingMic.ts';
import type { WakeWord } from '../audio/wakeWord.ts';
import { RmsVad } from '../audio/vad.ts';
import {
  generateConfirmBlip,
  generateConfirmOnBlip,
  generateConfirmOffBlip,
  generateListenBlip,
} from '../audio/blip.ts';
import { bufferToStream, isAbortError } from '../audio/streamHelpers.ts';

const BLIP_SAMPLE_RATE = 24000;
const CONFIRM_BLIP = generateConfirmBlip(BLIP_SAMPLE_RATE);
const CONFIRM_ON_BLIP = generateConfirmOnBlip(BLIP_SAMPLE_RATE);
const CONFIRM_OFF_BLIP = generateConfirmOffBlip(BLIP_SAMPLE_RATE);
const LISTEN_BLIP = generateListenBlip(BLIP_SAMPLE_RATE);

export interface OrchestratorOptions {
  agent: Agent;
  stt: Stt;
  tts: Tts;
  speaker: SpeakerOutput;
  wake: WakeWord;
  sampleRate: number;
  /** Reopen listening after the assistant speaks (no extra wake word needed).
   * Off by default — speaker echo into the mic causes the assistant to talk
   * to itself. Safe to enable with headphones or proper acoustic isolation. */
  followUp?: boolean;
}

const DEFAULT_VAD_THRESHOLD = 300;
const DEFAULT_VAD_SILENCE_MS = 800;
/** If the user goes silent immediately after the wake word and never crosses
 * the VAD threshold, we'd otherwise wait forever. Abort after this long. */
const NO_SPEECH_TIMEOUT_MS = 5000;

export class Orchestrator {
  private state: State = 'idle';
  private mic: StreamingMic;
  private vad: RmsVad;
  private captureBuffer: Buffer[] = [];
  private capturing = false;
  private speechSeen = false;
  private noSpeechTimer: NodeJS.Timeout | null = null;
  private currentSpeechAbort: AbortController | null = null;
  private readonly opts: OrchestratorOptions;

  constructor(opts: OrchestratorOptions) {
    this.opts = opts;
    this.mic = new StreamingMic({
      sampleRate: opts.sampleRate,
      frameLength: opts.wake.frameLength,
    });
    this.vad = new RmsVad({
      sampleRate: opts.sampleRate,
      frameLength: opts.wake.frameLength,
      threshold: DEFAULT_VAD_THRESHOLD,
      silenceMs: DEFAULT_VAD_SILENCE_MS,
    });
  }

  async run(): Promise<void> {
    await this.opts.wake.start();
    this.opts.wake.onWake((kw, score) => {
      // FSM decides whether to act on this:
      //   idle      → wake → listening (normal start)
      //   speaking  → wake → listening (barge-in: stop TTS, start fresh capture)
      //   listening → wake → ignored (already capturing)
      //   thinking  → wake → ignored (LLM in flight)
      const tag = this.state === 'speaking' ? 'barge-in' : 'wake';
      console.log(`[${tag}] ${kw} score=${score.toFixed(2)}`);
      this.dispatch({ type: 'wake' });
    });
    this.vad.onSpeech(() => {
      if (!this.capturing) return;
      this.speechSeen = true;
      this.clearNoSpeechTimer();
    });
    this.vad.onSilence(() => {
      if (!this.capturing) return;
      this.endCapture();
    });

    this.mic.onFrame((frame) => {
      this.opts.wake.feed(frame);
      if (this.capturing) {
        this.captureBuffer.push(Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength));
        this.vad.feed(frame);
      }
    });

    this.mic.start();
    console.log('Voice assistant running. Say the wake word to talk.');
    await new Promise(() => {}); // run forever
  }

  private endCapture(): void {
    this.capturing = false;
    this.clearNoSpeechTimer();
    const audio = Buffer.concat(this.captureBuffer);
    this.captureBuffer = [];
    this.dispatch({ type: 'utteranceEnd', audio });
  }

  private clearNoSpeechTimer(): void {
    if (this.noSpeechTimer) {
      clearTimeout(this.noSpeechTimer);
      this.noSpeechTimer = null;
    }
  }

  private async dispatch(event: Event): Promise<void> {
    const { state, effects } = transition(this.state, event, {
      followUp: this.opts.followUp ?? false,
    });
    this.state = state;
    for (const eff of effects) await this.runEffect(eff);
  }

  private async runEffect(eff: Effect): Promise<void> {
    switch (eff.type) {
      case 'startCapture':
        // Audible "I'm listening" cue. Fire-and-forget so we don't delay
        // capture start; the chime is short (~140ms) and won't mask early
        // speech for normal users.
        this.opts.speaker.playStream(bufferToStream(LISTEN_BLIP, BLIP_SAMPLE_RATE)).catch(() => {});
        this.capturing = true;
        this.captureBuffer = [];
        this.vad.reset();
        this.speechSeen = false;
        this.clearNoSpeechTimer();
        this.noSpeechTimer = setTimeout(() => {
          if (!this.capturing || this.speechSeen) return;
          console.log('[no command heard within 5s — returning to idle]');
          this.endCapture();
        }, NO_SPEECH_TIMEOUT_MS);
        return;
      case 'stopSpeaking':
        this.currentSpeechAbort?.abort();
        this.opts.speaker.stop();
        return;
      case 'transcribeAndAsk':
        try {
          const text = (
            await this.opts.stt.transcribe(eff.audio, {
              sampleRate: this.opts.sampleRate,
              language: 'ru',
            })
          ).trim();
          if (!text) {
            console.log('[empty transcript — say a command right after the wake word]');
            await this.dispatch({ type: 'speechFinished' });
            return;
          }
          console.log(`User: ${text}`);
          const reply = await this.opts.agent.respond(text);
          await this.dispatch({
            type: 'agentReplied',
            text: reply.text,
            direction: reply.direction,
            expectsFollowUp: reply.expectsFollowUp,
          });
        } catch (e) {
          await this.dispatch({
            type: 'error',
            message: e instanceof Error ? e.message : String(e),
          });
        }
        return;
      case 'speak':
        this.currentSpeechAbort = new AbortController();
        try {
          if (eff.direction !== null) {
            const blip =
              eff.direction === 'on'
                ? CONFIRM_ON_BLIP
                : eff.direction === 'off'
                  ? CONFIRM_OFF_BLIP
                  : CONFIRM_BLIP;
            console.log(`Assistant: [${eff.direction}] (silent confirm)`);
            await this.opts.speaker.playStream(bufferToStream(blip, BLIP_SAMPLE_RATE), {
              signal: this.currentSpeechAbort.signal,
            });
          } else {
            const stream = this.opts.tts.stream(eff.text, {
              signal: this.currentSpeechAbort.signal,
            });
            console.log(`Assistant: ${eff.text}`);
            await this.opts.speaker.playStream(stream, {
              signal: this.currentSpeechAbort.signal,
            });
          }
        } catch (e) {
          if (!isAbortError(e)) console.error('TTS error', e);
        } finally {
          this.currentSpeechAbort = null;
          if (eff.expectsFollowUp) {
            await this.dispatch({ type: 'followUpRequested' });
          } else {
            await this.dispatch({ type: 'speechFinished' });
          }
        }
        return;
      case 'log':
        if (eff.level === 'error') console.error(eff.message);
        else console.log(eff.message);
        return;
    }
  }
}
