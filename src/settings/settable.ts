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
export const SETTABLE_KEYS: SettableKey[] = [
  { key: 'OPENAI_MODEL', label: 'OpenAI model', kind: 'string', group: 'openai' },
  {
    key: 'OPENAI_REASONING_EFFORT',
    label: 'Reasoning effort',
    kind: 'enum',
    options: ['minimal', 'low', 'medium', 'high'],
    group: 'openai',
  },
  {
    key: 'OPENAI_WEB_SEARCH',
    label: 'Web search tool',
    kind: 'boolean',
    group: 'openai',
    help: 'Enables OpenAI hosted web_search. Costs tokens per call.',
  },
  {
    key: 'OPENAI_REALTIME_MODEL',
    label: 'Realtime model',
    kind: 'string',
    group: 'realtime',
  },
  { key: 'OPENAI_REALTIME_VOICE', label: 'Realtime voice', kind: 'string', group: 'realtime' },
  {
    key: 'OPENAI_REALTIME_REASONING_EFFORT',
    label: 'Realtime reasoning effort',
    kind: 'enum',
    options: ['minimal', 'low', 'medium', 'high', 'xhigh'],
    group: 'realtime',
  },
  {
    key: 'REALTIME_OUTPUT_PACING_MS',
    label: 'Output pacing (ms)',
    kind: 'number',
    group: 'realtime',
  },
  {
    key: 'REALTIME_IDLE_RESET_MS',
    label: 'Idle reset (ms)',
    kind: 'number',
    group: 'realtime',
  },
  {
    key: 'AGENT_MODE',
    label: 'Agent mode',
    kind: 'enum',
    options: ['telegram', 'http', 'both'],
    group: 'general',
  },
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
