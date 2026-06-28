import type { SettingsStore } from './types.ts';

/** HTTP server runtime config, read straight from the `settings` table — DB-only
 *  (never env), like `resolveRealtimeConfig`. The listen port stays in
 *  `config.ts` (infra/env); only the enable switch lives here. Defaults off:
 *  the HTTP `/text` `/audio` `/assist` server is opt-in via the web panel. */
export interface HttpConfig {
  enabled: boolean;
}

export const HTTP_KEYS = {
  enabled: 'http.enabled',
} as const;

export function resolveHttpConfig(store: SettingsStore): HttpConfig {
  return { enabled: store.get(HTTP_KEYS.enabled) === '1' };
}
