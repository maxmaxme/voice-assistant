// HTTP endpoint toggles: DB-only, read/written via /api/http (not the generic
// settings env-overlay). KEEP the key strings in sync with voice-assistant
// src/settings/httpConfig.ts. /health has no flag — it's always served.

export const HTTP_KEYS = {
  text: 'http.text',
  audio: 'http.audio',
  assist: 'http.assist',
} as const

export type HttpEndpoint = keyof typeof HTTP_KEYS

export interface HttpForm {
  text: boolean
  audio: boolean
  assist: boolean
}

export function readHttp(all: Record<string, string>): HttpForm {
  return {
    text: all[HTTP_KEYS.text] === '1',
    audio: all[HTTP_KEYS.audio] === '1',
    assist: all[HTTP_KEYS.assist] === '1',
  }
}
