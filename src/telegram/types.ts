export interface TelegramSender {
  send(text: string): Promise<void>;
}

export type TelegramMessage =
  | {
      updateId: number;
      chatId: number;
      fromUserId: number;
      kind: 'text';
      text: string;
      receivedAt: number;
    }
  | {
      updateId: number;
      chatId: number;
      fromUserId: number;
      kind: 'voice';
      /** Telegram file_id; download via getFile when implemented. */
      fileId: string;
      durationSec: number;
      receivedAt: number;
    }
  | {
      updateId: number;
      chatId: number;
      fromUserId: number;
      kind: 'photo';
      /** Telegram file_id of the largest photo size. */
      fileId: string;
      /** Optional caption attached to the photo. */
      caption?: string;
      receivedAt: number;
    }
  | {
      updateId: number;
      chatId: number;
      fromUserId: number;
      kind: 'photo-album-rejected';
      receivedAt: number;
    }
  | {
      updateId: number;
      chatId: number;
      fromUserId: number;
      kind: 'unsupported';
      reason: string;
      receivedAt: number;
    };

export interface TelegramReceiver {
  /** Async iterator of messages. Implementations long-poll under the hood. */
  messages(): AsyncIterable<TelegramMessage>;
  stop(): Promise<void>;
}
