import type { Agent } from '../agent/types.js';
import type { Stt, Tts, SpeakerOutput } from '../audio/types.js';
import type { State, Event, Effect } from './types.js';
import { transition } from './fsm.js';
import { StreamingMic } from '../audio/streamingMic.js';
import type { WakeWord } from '../audio/wakeWord.js';
import { RmsVad } from '../audio/vad.js';

export interface OrchestratorOptions {
  agent: Agent;
  stt: Stt;
  tts: Tts;
  speaker: SpeakerOutput;
  wake: WakeWord;
  sampleRate: number;
}

export class Orchestrator {
  private state: State = 'idle';
  private mic: StreamingMic;
  private vad: RmsVad;
  private captureBuffer: Buffer[] = [];
  private capturing = false;

  constructor(private readonly opts: OrchestratorOptions) {
    this.mic = new StreamingMic({
      sampleRate: opts.sampleRate,
      frameLength: opts.wake.frameLength,
    });
    this.vad = new RmsVad({
      sampleRate: opts.sampleRate,
      frameLength: opts.wake.frameLength,
      threshold: 800,
      silenceMs: 800,
    });
  }

  async run(): Promise<void> {
    await this.opts.wake.start();
    this.opts.wake.onWake((kw, score) => {
      console.log(`[wake] ${kw} score=${score.toFixed(2)} → listening (say your command)`);
      this.dispatch({ type: 'wake' });
    });
    this.vad.onSilence(() => {
      if (!this.capturing) return;
      this.capturing = false;
      const audio = Buffer.concat(this.captureBuffer);
      this.captureBuffer = [];
      this.dispatch({ type: 'utteranceEnd', audio });
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

  private async dispatch(event: Event): Promise<void> {
    const { state, effects } = transition(this.state, event);
    this.state = state;
    for (const eff of effects) await this.runEffect(eff);
  }

  private async runEffect(eff: Effect): Promise<void> {
    switch (eff.type) {
      case 'startCapture':
        this.capturing = true;
        this.captureBuffer = [];
        this.vad.reset();
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
          await this.dispatch({ type: 'agentReplied', text: reply.text });
        } catch (e) {
          await this.dispatch({ type: 'error', message: e instanceof Error ? e.message : String(e) });
        }
        return;
      case 'speak':
        try {
          const { audio, sampleRate } = await this.opts.tts.synthesize(eff.text);
          console.log(`Assistant: ${eff.text}`);
          await this.opts.speaker.play(audio, { sampleRate });
        } catch (e) {
          console.error('TTS error', e);
        } finally {
          await this.dispatch({ type: 'speechFinished' });
        }
        return;
      case 'log':
        if (eff.level === 'error') console.error(eff.message);
        else console.log(eff.message);
        return;
    }
  }
}
