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

// OpenAI knobs (model, reasoning effort, web_search, realtime model) live on the
// OpenAI integration. Realtime enable + pacing + idle are DB-only config with
// their own /api/realtime endpoint + page (see realtime.ts), not env overrides.
// KEEP IN SYNC with voice-assistant src/settings/settable.ts.
export const SETTABLE_KEYS: SettableKey[] = [
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
