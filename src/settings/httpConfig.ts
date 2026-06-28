import type { SettingsStore } from './types.ts';

/** Per-endpoint HTTP toggles, read straight from the `settings` table — DB-only
 *  (never env), like `resolveRealtimeConfig`. `/health` has no flag: the HTTP
 *  server always starts (so the container healthcheck stays green) and each of
 *  `/text` `/audio` `/assist` is mounted only when its flag is on. All default
 *  off — opt-in via the web panel. The listen port stays in `config.ts`. */
export interface HttpConfig {
  text: boolean;
  audio: boolean;
  assist: boolean;
}

export const HTTP_KEYS = {
  text: 'http.text',
  audio: 'http.audio',
  assist: 'http.assist',
} as const;

export function resolveHttpConfig(store: SettingsStore): HttpConfig {
  return {
    text: store.get(HTTP_KEYS.text) === '1',
    audio: store.get(HTTP_KEYS.audio) === '1',
    assist: store.get(HTTP_KEYS.assist) === '1',
  };
}
