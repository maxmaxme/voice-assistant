// Telegram channel enable: DB-only, read/written via /api/telegram. Separate
// from the Telegram integration (which holds the bot token) — installing the
// integration alone doesn't run the bot. KEEP in sync with voice-assistant
// src/settings/telegramRuntime.ts.

export const TELEGRAM_KEYS = {
  enabled: 'telegram.enabled',
} as const

export interface TelegramForm {
  enabled: boolean
}

export function readTelegram(all: Record<string, string>): TelegramForm {
  return { enabled: all[TELEGRAM_KEYS.enabled] === '1' }
}
