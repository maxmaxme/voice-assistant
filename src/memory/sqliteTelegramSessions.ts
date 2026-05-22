import type Database from 'better-sqlite3';
import type { PendingToolOutput, TelegramSessionRecord, TelegramSessionsAdapter } from './types.ts';

interface Row {
  chat_id: number;
  last_response_id: string | null;
  pending_ask_call_id: string | null;
  pending_tool_outputs: string | null;
}

export class SqliteTelegramSessions implements TelegramSessionsAdapter {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  get(chatId: number): TelegramSessionRecord | null {
    const row = this.db
      .prepare<number, Row>(
        `SELECT chat_id, last_response_id, pending_ask_call_id, pending_tool_outputs
         FROM telegram_sessions WHERE chat_id = ?`,
      )
      .get(chatId);
    if (!row) {
      return null;
    }
    return {
      lastResponseId: row.last_response_id ?? undefined,
      pendingAskCallId: row.pending_ask_call_id ?? undefined,
      pendingToolOutputs: parsePendingOutputs(row.pending_tool_outputs),
    };
  }

  save(chatId: number, record: TelegramSessionRecord): void {
    const outputsJson =
      record.pendingToolOutputs && record.pendingToolOutputs.length > 0
        ? JSON.stringify(record.pendingToolOutputs)
        : null;
    this.db
      .prepare(
        `INSERT INTO telegram_sessions
           (chat_id, last_response_id, pending_ask_call_id, pending_tool_outputs, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET
           last_response_id     = excluded.last_response_id,
           pending_ask_call_id  = excluded.pending_ask_call_id,
           pending_tool_outputs = excluded.pending_tool_outputs,
           updated_at           = excluded.updated_at`,
      )
      .run(
        chatId,
        record.lastResponseId ?? null,
        record.pendingAskCallId ?? null,
        outputsJson,
        Date.now(),
      );
  }

  delete(chatId: number): void {
    this.db.prepare('DELETE FROM telegram_sessions WHERE chat_id = ?').run(chatId);
  }
}

function parsePendingOutputs(raw: string | null): PendingToolOutput[] | undefined {
  if (!raw) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) {
    return undefined;
  }
  const result: PendingToolOutput[] = [];
  for (const item of parsed) {
    if (isPendingToolOutput(item)) {
      result.push(item);
    }
  }
  return result.length > 0 ? result : undefined;
}

function isPendingToolOutput(value: unknown): value is PendingToolOutput {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const callId = Reflect.get(value, 'callId');
  const output = Reflect.get(value, 'output');
  return typeof callId === 'string' && typeof output === 'string';
}
