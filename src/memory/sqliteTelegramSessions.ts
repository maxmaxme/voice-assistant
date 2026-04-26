import type Database from 'better-sqlite3';
import type { TelegramSessionRecord, TelegramSessionsAdapter } from './types.ts';

interface Row {
  chat_id: number;
  last_response_id: string | null;
  pending_ask_call_id: string | null;
}

export class SqliteTelegramSessions implements TelegramSessionsAdapter {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  get(chatId: number): TelegramSessionRecord | null {
    const row = this.db
      .prepare(
        `SELECT chat_id, last_response_id, pending_ask_call_id
         FROM telegram_sessions WHERE chat_id = ?`,
      )
      .get(chatId) as Row | undefined;
    if (!row) {
      return null;
    }
    return {
      lastResponseId: row.last_response_id ?? undefined,
      pendingAskCallId: row.pending_ask_call_id ?? undefined,
    };
  }

  save(chatId: number, record: TelegramSessionRecord): void {
    this.db
      .prepare(
        `INSERT INTO telegram_sessions
           (chat_id, last_response_id, pending_ask_call_id, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET
           last_response_id    = excluded.last_response_id,
           pending_ask_call_id = excluded.pending_ask_call_id,
           updated_at          = excluded.updated_at`,
      )
      .run(chatId, record.lastResponseId ?? null, record.pendingAskCallId ?? null, Date.now());
  }

  delete(chatId: number): void {
    this.db.prepare('DELETE FROM telegram_sessions WHERE chat_id = ?').run(chatId);
  }
}
