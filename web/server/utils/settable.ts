// KEEP IN SYNC with voice-assistant `src/settings/settable.ts` — that file is
// the source of truth (the read side at process start). This copy exists so the
// Nitro server bundles cleanly without cross-root TS imports. A future refactor
// should extract a shared package. Secrets are deliberately never listed here.

export type SettableKind = 'string' | 'number' | 'enum' | 'boolean'

export interface SettableKey {
  key: string
  label: string
  kind: SettableKind
  options?: string[]
  group: 'openai' | 'realtime' | 'general'
  help?: string
}

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
  { key: 'OPENAI_REALTIME_MODEL', label: 'Realtime model', kind: 'string', group: 'realtime' },
  { key: 'OPENAI_REALTIME_VOICE', label: 'Realtime voice', kind: 'string', group: 'realtime' },
  {
    key: 'OPENAI_REALTIME_REASONING_EFFORT',
    label: 'Realtime reasoning effort',
    kind: 'enum',
    options: ['minimal', 'low', 'medium', 'high', 'xhigh'],
    group: 'realtime',
  },
  { key: 'REALTIME_OUTPUT_PACING_MS', label: 'Output pacing (ms)', kind: 'number', group: 'realtime' },
  { key: 'REALTIME_IDLE_RESET_MS', label: 'Idle reset (ms)', kind: 'number', group: 'realtime' },
  {
    key: 'AGENT_MODE',
    label: 'Agent mode',
    kind: 'enum',
    options: ['telegram', 'http', 'both'],
    group: 'general',
  },
  { key: 'TZ', label: 'Server timezone (IANA)', kind: 'string', group: 'general' },
]

export const SETTABLE_BY_KEY: Map<string, SettableKey> = new Map(
  SETTABLE_KEYS.map(k => [k.key, k]),
)

/** Validate a proposed value for a settable key. Returns an error message, or
 *  null when the value is acceptable. */
export function validateSetting(key: string, value: string): string | null {
  const meta = SETTABLE_BY_KEY.get(key)
  if (!meta) {
    return `Unknown or non-settable key: ${key}`
  }
  if (meta.kind === 'enum' && meta.options && !meta.options.includes(value)) {
    return `${key} must be one of: ${meta.options.join(', ')}`
  }
  if (meta.kind === 'number' && value !== '' && Number.isNaN(Number(value))) {
    return `${key} must be a number`
  }
  if (meta.kind === 'boolean' && value !== '' && value !== '1') {
    return `${key} must be '1' (on) or '' (off)`
  }
  return null
}
