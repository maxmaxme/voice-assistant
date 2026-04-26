import type { Config } from '../config.ts';
import Database from 'better-sqlite3';
import { runMigrations } from '../memory/migrate.ts';
import { SqliteOffsetStore } from './sqliteOffsetStore.ts';
import { BotTelegramSender } from './telegramSender.ts';
import { PollingTelegramReceiver } from './pollingReceiver.ts';
import type { TelegramSender, TelegramReceiver } from './types.ts';

export function telegramFromConfig(cfg: Config): TelegramSender {
  return new BotTelegramSender({
    botToken: cfg.telegram.botToken,
    chatId: cfg.telegram.chatId,
  });
}

export function receiverFromConfig(cfg: Config): TelegramReceiver {
  const db = new Database(cfg.memory.dbPath);
  db.pragma('journal_mode = WAL');
  runMigrations(db); // idempotent — OK to run twice (SqliteProfileMemory ran first)
  const offsetStore = new SqliteOffsetStore({ db, key: 'telegram.offset' });
  return new PollingTelegramReceiver({
    botToken: cfg.telegram.botToken,
    offsetStore,
    onStop: () => db.close(),
  });
}
