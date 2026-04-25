export interface TelegramSender {
  send(text: string): Promise<void>;
}
