// HTTP server config: DB-only, read/written via /api/http (not the generic
// settings env-overlay). KEEP the key string in sync with voice-assistant
// src/settings/httpConfig.ts.

export const HTTP_KEYS = {
  enabled: 'http.enabled',
} as const

export interface HttpForm {
  enabled: boolean
}

export function readHttp(all: Record<string, string>): HttpForm {
  return { enabled: all[HTTP_KEYS.enabled] === '1' }
}
