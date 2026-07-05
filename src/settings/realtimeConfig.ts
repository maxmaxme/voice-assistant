import { flagDefaultOff, flagDefaultOn } from './flags.ts';
import type { SettingsStore } from './types.ts';

/** Realtime (Voice PE) runtime config, read straight from the `settings` table
 *  — like the integration resolvers, not via the env overlay. These keys are
 *  intentionally NOT env-var names: realtime config is DB-only and never read
 *  from `process.env`. Device token + port stay in `config.ts` (infra/secret). */
export interface RealtimeConfig {
  enabled: boolean;
  outputPacingMs: number;
  idleResetMs: number;
  followUpMs: number;
  requestFollowUpMs: number;
  followUpChime: boolean;
  wakeChime: boolean;
}

export const REALTIME_KEYS = {
  enabled: 'realtime.enabled',
  outputPacingMs: 'realtime.outputPacingMs',
  idleResetMs: 'realtime.idleResetMs',
  followUpMs: 'realtime.followUpMs',
  requestFollowUpMs: 'realtime.requestFollowUpMs',
  followUpChime: 'realtime.followUpChime',
  wakeChime: 'realtime.wakeChime',
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
  };
}
