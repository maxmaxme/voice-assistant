import type { Message } from './types.js';

export interface ConversationStoreOptions {
  idleTimeoutMs: number;
  maxMessages: number;
  now?: () => number;
}

export class ConversationStore {
  private messages: Message[] = [];
  private lastTouch = 0;
  private readonly opts: Required<ConversationStoreOptions>;

  constructor(opts: ConversationStoreOptions) {
    this.opts = { now: () => Date.now(), ...opts };
  }

  append(msg: Message): void {
    this.evictIfStale();
    this.messages.push(msg);
    this.lastTouch = this.opts.now();
    this.trim();
  }

  history(): Message[] {
    this.evictIfStale();
    return [...this.messages];
  }

  reset(): void {
    this.messages = [];
    this.lastTouch = 0;
  }

  private evictIfStale(): void {
    if (this.lastTouch === 0) return;
    if (this.opts.now() - this.lastTouch >= this.opts.idleTimeoutMs) {
      this.messages = [];
      this.lastTouch = 0;
    }
  }

  private trim(): void {
    if (this.messages.length <= this.opts.maxMessages) return;
    const system = this.messages.filter((m) => m.role === 'system');
    const rest = this.messages.filter((m) => m.role !== 'system');
    const keepRest = rest.slice(-(this.opts.maxMessages - system.length));
    this.messages = [...system, ...keepRest];
  }
}
