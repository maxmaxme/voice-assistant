import type { SettingsStore } from './types.ts';

/** Realtime (Voice PE) runtime config, read straight from the `settings` table
 *  — like the integration resolvers, not via the env overlay. These keys are
 *  intentionally NOT env-var names: realtime config is DB-only and never read
 *  from `process.env`. Device token + port stay in `config.ts` (infra/secret). */
export interface RealtimeConfig {
  enabled: boolean;
  outputPacingMs: number;
  idleResetMs: number;
}

export const REALTIME_KEYS = {
  enabled: 'realtime.enabled',
  outputPacingMs: 'realtime.outputPacingMs',
  idleResetMs: 'realtime.idleResetMs',
} as const;

const DEFAULTS: RealtimeConfig = {
  enabled: false,
  // Re-clock OpenAI's bursty reply audio into ~real-time frames (see config.ts
  // history); 90s idle reset matches the prior env default.
  outputPacingMs: 20,
  idleResetMs: 90_000,
};

function num(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function resolveRealtimeConfig(store: SettingsStore): RealtimeConfig {
  return {
    enabled: store.get(REALTIME_KEYS.enabled) === '1',
    outputPacingMs: num(store.get(REALTIME_KEYS.outputPacingMs), DEFAULTS.outputPacingMs),
    idleResetMs: num(store.get(REALTIME_KEYS.idleResetMs), DEFAULTS.idleResetMs),
  };
}
