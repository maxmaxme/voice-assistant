import { eq } from 'drizzle-orm';
import type { Db } from './db.ts';
import { telegramSessions } from './schema.ts';
import type { PendingToolOutput, TelegramSessionRecord, TelegramSessionsAdapter } from './types.ts';

export class SqliteTelegramSessions implements TelegramSessionsAdapter {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  get(chatId: number): TelegramSessionRecord | null {
    const row = this.db
      .select({
        lastResponseId: telegramSessions.lastResponseId,
        pendingAskCallId: telegramSessions.pendingAskCallId,
        pendingToolOutputs: telegramSessions.pendingToolOutputs,
      })
      .from(telegramSessions)
      .where(eq(telegramSessions.chatId, chatId))
      .get();
    if (!row) {
      return null;
    }
    return {
      lastResponseId: row.lastResponseId ?? undefined,
      pendingAskCallId: row.pendingAskCallId ?? undefined,
      pendingToolOutputs: parsePendingOutputs(row.pendingToolOutputs),
    };
  }

  save(chatId: number, record: TelegramSessionRecord): void {
    const outputsJson =
      record.pendingToolOutputs && record.pendingToolOutputs.length > 0
        ? JSON.stringify(record.pendingToolOutputs)
        : null;
    const values = {
      chatId,
      lastResponseId: record.lastResponseId ?? null,
      pendingAskCallId: record.pendingAskCallId ?? null,
      pendingToolOutputs: outputsJson,
      updatedAt: Date.now(),
    };
    this.db
      .insert(telegramSessions)
      .values(values)
      .onConflictDoUpdate({
        target: telegramSessions.chatId,
        set: {
          lastResponseId: values.lastResponseId,
          pendingAskCallId: values.pendingAskCallId,
          pendingToolOutputs: values.pendingToolOutputs,
          updatedAt: values.updatedAt,
        },
      })
      .run();
  }

  delete(chatId: number): void {
    this.db.delete(telegramSessions).where(eq(telegramSessions.chatId, chatId)).run();
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
