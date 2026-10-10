import { flagDefaultOff, flagDefaultOn } from './flags.ts';
import type { SettingsStore } from './types.ts';

/** Realtime (Voice PE) runtime config, read straight from the `settings` table
 *  — like the integration resolvers, not via the env overlay. These keys are
 *  intentionally NOT env-var names: realtime config is DB-only and never read
 *  from `process.env`. Device token + port stay in `config.ts` (infra/secret). */
/** OpenAI's server-side input filter, applied before VAD and the model.
 *  'off' is upstream's default; we default to far_field for across-the-room
 *  mics. */
export type NoiseReduction = 'far_field' | 'near_field' | 'off';

/** How the Realtime session decides the user finished speaking. `server_vad`
 *  closes the turn after a fixed run of silence; the `semantic_*` modes use
 *  OpenAI's semantic VAD, which judges from the words whether the user is done
 *  (so a mid-sentence pause doesn't split the turn). The suffix is semantic
 *  VAD's eagerness: low waits longest (max 8s), high replies fastest (max 2s). */
export type TurnDetection = 'server_vad' | 'semantic_low' | 'semantic_medium' | 'semantic_high';

/** Model for the optional transcription pass over the user's audio. */
export type TranscriptionModel = 'whisper-1' | 'gpt-4o-mini-transcribe' | 'gpt-4o-transcribe';

export interface RealtimeConfig {
  enabled: boolean;
  outputPacingMs: number;
  idleResetMs: number;
  followUpMs: number;
  requestFollowUpMs: number;
  followUpChime: boolean;
  wakeChime: boolean;
  /** ISO 639-1 code of the language the household speaks, '' = let the model
   *  and Whisper auto-detect. */
  language: string;
  transcription: boolean;
  transcriptionModel: TranscriptionModel;
  noiseReduction: NoiseReduction;
  turnDetection: TurnDetection;
}

export const REALTIME_KEYS = {
  enabled: 'realtime.enabled',
  outputPacingMs: 'realtime.outputPacingMs',
  idleResetMs: 'realtime.idleResetMs',
  followUpMs: 'realtime.followUpMs',
  requestFollowUpMs: 'realtime.requestFollowUpMs',
  followUpChime: 'realtime.followUpChime',
  wakeChime: 'realtime.wakeChime',
  language: 'realtime.language',
  transcription: 'realtime.transcription',
  transcriptionModel: 'realtime.transcriptionModel',
  noiseReduction: 'realtime.noiseReduction',
  turnDetection: 'realtime.turnDetection',
} as const;

const DEFAULTS: RealtimeConfig = {
  enabled: false,
  // Re-clock OpenAI's bursty reply audio into ~real-time frames (see config.ts
  // history); 90s idle reset matches the prior env default.
  outputPacingMs: 20,
  idleResetMs: 90_000,
  // Ambient window: how long the device keeps the mic open after ANY spoken
  // reply so the user can continue without a wake word. 0 disables it.
  followUpMs: 8_000,
  // Explicit-question window: when the model calls request_follow_up it always
  // reopens the mic for this long — independent of followUpMs, since a question
  // is useless if the user can't answer. Longer, since the user was just asked
  // something. 0 disables even explicit follow-ups.
  requestFollowUpMs: 10_000,
  // Play a chime when the assistant explicitly asks the user a question and
  // waits for the answer (the request_follow_up tool). Off by default.
  followUpChime: false,
  // Play the local wake-word beep when the device wakes. Pushed to the device
  // in `hello`. On by default (matches the stock firmware behaviour).
  wakeChime: true,
  // Auto-detect by default. Pinning it both tells the model which language to
  // expect (it otherwise mishears a non-English household as accented English)
  // and pins Whisper's transcription language.
  language: '',
  // Whisper transcription of the user's audio, for logs/memory only — the
  // Realtime model does its own STT regardless, so this is pure extra spend per
  // turn. Off by default; turn it on when debugging what the speaker heard.
  transcription: false,
  // whisper-1 is the long-standing default; the gpt-4o transcribe models
  // hallucinate less on short / silence-heavy turns.
  transcriptionModel: 'whisper-1',
  // Across-the-room mics with weak SNR — filtering before VAD buys fewer false
  // turns and better recognition. 'near_field' suits a headset/close mic.
  noiseReduction: 'far_field',
  // The tuned silence-based VAD; semantic VAD is opt-in until it has proven
  // itself on the across-the-room speakers.
  turnDetection: 'server_vad',
};

function num(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }
  const n = Number(value);
  // All realtime numerics are durations: negatives would feed nonsense into
  // timers (0 stays valid — it means "disabled" for the follow-up windows).
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function noiseReduction(value: string | undefined): NoiseReduction {
  const v = (value ?? '').trim();
  switch (v) {
    case 'far_field':
    case 'near_field':
    case 'off':
      return v;
    default:
      return DEFAULTS.noiseReduction;
  }
}

function turnDetection(value: string | undefined): TurnDetection {
  const v = (value ?? '').trim();
  switch (v) {
    case 'server_vad':
    case 'semantic_low':
    case 'semantic_medium':
    case 'semantic_high':
      return v;
    default:
      return DEFAULTS.turnDetection;
  }
}

function transcriptionModel(value: string | undefined): TranscriptionModel {
  const v = (value ?? '').trim();
  switch (v) {
    case 'whisper-1':
    case 'gpt-4o-mini-transcribe':
    case 'gpt-4o-transcribe':
      return v;
    default:
      return DEFAULTS.transcriptionModel;
  }
}

/** The device-facing realtime config — exactly what the `hello` message carries
 *  to the speaker. Today just `wakeChime`; add a field here (and to the `hello`
 *  ServerMessage + the firmware) to expose a new device setting, and the
 *  wsServer watcher's diff-and-re-send-hello plumbing carries it automatically —
 *  no per-setting code. NOT for server-side realtime config (follow-up windows,
 *  pacing, idle reset): those never reach the device and stay restart-only. */
export interface RealtimeDeviceConfig {
  wakeChime: boolean;
}

export function realtimeDeviceConfig(c: RealtimeConfig): RealtimeDeviceConfig {
  return { wakeChime: c.wakeChime };
}

export function resolveRealtimeConfig(store: SettingsStore): RealtimeConfig {
  return {
    enabled: flagDefaultOff(store.get(REALTIME_KEYS.enabled)),
    outputPacingMs: num(store.get(REALTIME_KEYS.outputPacingMs), DEFAULTS.outputPacingMs),
    idleResetMs: num(store.get(REALTIME_KEYS.idleResetMs), DEFAULTS.idleResetMs),
    followUpMs: num(store.get(REALTIME_KEYS.followUpMs), DEFAULTS.followUpMs),
    requestFollowUpMs: num(store.get(REALTIME_KEYS.requestFollowUpMs), DEFAULTS.requestFollowUpMs),
    followUpChime: flagDefaultOff(store.get(REALTIME_KEYS.followUpChime)),
    wakeChime: flagDefaultOn(store.get(REALTIME_KEYS.wakeChime)),
    language: (store.get(REALTIME_KEYS.language) ?? '').trim().toLowerCase(),
    transcription: flagDefaultOff(store.get(REALTIME_KEYS.transcription)),
    transcriptionModel: transcriptionModel(store.get(REALTIME_KEYS.transcriptionModel)),
    noiseReduction: noiseReduction(store.get(REALTIME_KEYS.noiseReduction)),
    turnDetection: turnDetection(store.get(REALTIME_KEYS.turnDetection)),
  };
}
