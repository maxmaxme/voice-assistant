import type { SqliteIntegrations } from './sqliteIntegrations.ts';

/** Matches the integration `type` key in the web catalog
 *  (`web/server/utils/integrations.ts`). */
export const TELEGRAM_INTEGRATION_TYPE = 'telegram';

export interface TelegramConfig {
  botToken: string;
}

/** The configured Telegram bot, or null when the integration is not installed,
 *  **disabled**, or missing a token. Null = no Telegram: the telegram runner
 *  doesn't start and any outbound send (goal delivery, `send_to_telegram`)
 *  fails loudly rather than silently dropping. */
export function resolveTelegramConfig(store: SqliteIntegrations): TelegramConfig | null {
  const row = store.get(TELEGRAM_INTEGRATION_TYPE);
  if (!row || !row.enabled) {
    return null;
  }
  const botToken = (row.config.botToken ?? '').trim();
  if (!botToken) {
    return null;
  }
  return { botToken };
}
