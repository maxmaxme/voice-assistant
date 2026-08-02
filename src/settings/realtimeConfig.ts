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
  noiseReduction: NoiseReduction;
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
  noiseReduction: 'realtime.noiseReduction',
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
  // Across-the-room mics with weak SNR — filtering before VAD buys fewer false
  // turns and better recognition. 'near_field' suits a headset/close mic.
  noiseReduction: 'far_field',
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
    noiseReduction: noiseReduction(store.get(REALTIME_KEYS.noiseReduction)),
  };
}
