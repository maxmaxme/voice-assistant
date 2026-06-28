import type { SettingsStore } from './types.ts';

export type SettableKind = 'string' | 'number' | 'enum' | 'boolean';

export interface SettableKey {
  /** Environment-variable name this setting overrides. */
  key: string;
  label: string;
  kind: SettableKind;
  /** Allowed values for `kind: 'enum'`. */
  options?: string[];
  group: 'openai' | 'realtime' | 'general';
  help?: string;
}

/** The non-secret config knobs editable via the web UI. Secrets (API keys,
 *  bearer tokens) are deliberately absent — they stay in `.env` only. Keys are
 *  env-var names so `buildEnvOverlay` can layer them straight over
 *  `process.env`. */
// Provider-specific knobs (model, reasoning effort, voice, web_search, realtime
// model) live on the OpenAI *integration*. Realtime enable + pacing + idle are
// DB-only config read via `resolveRealtimeConfig` (not env), so they're not
// here either. Only process-level env overrides remain.
export const SETTABLE_KEYS: SettableKey[] = [
  { key: 'TZ', label: 'Server timezone (IANA)', kind: 'string', group: 'general' },
];

export const SETTABLE_KEY_NAMES: ReadonlySet<string> = new Set(SETTABLE_KEYS.map((k) => k.key));

/** Read the stored settings and keep only whitelisted (settable) keys, so a
 *  stray non-settable row can never override a secret env var at startup. */
export function buildEnvOverlay(store: SettingsStore): Record<string, string> {
  const all = store.getAll();
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(all)) {
    if (SETTABLE_KEY_NAMES.has(k)) {
      out[k] = v;
    }
  }
  return out;
}
