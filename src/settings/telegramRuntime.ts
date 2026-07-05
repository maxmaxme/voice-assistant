import { flagDefaultOff } from './flags.ts';
import type { SettingsStore } from './types.ts';

/** Whether the Telegram bot runner should start. DB-only (never env), separate
 *  from the integration that holds the bot token: installing/enabling the
 *  integration only makes credentials available — this toggle (web panel's
 *  Telegram page) is what actually runs the bot. Default off. */
export const TELEGRAM_KEYS = {
  enabled: 'telegram.enabled',
} as const;

export function resolveTelegramEnabled(store: SettingsStore): boolean {
  return flagDefaultOff(store.get(TELEGRAM_KEYS.enabled));
}
