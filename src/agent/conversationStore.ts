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

  length(): number {
    return this.messages.length;
  }

  truncateTo(length: number): void {
    if (length < 0 || length > this.messages.length) return;
    this.messages = this.messages.slice(0, length);
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
    let keepRest = rest.slice(-(this.opts.maxMessages - system.length));
    // Don't strand a 'tool' or assistant-with-tool_calls at the head:
    // OpenAI rejects history where a tool message has no preceding tool_calls,
    // and an assistant tool_calls without its tool replies is also broken.
    // Walk forward to the next 'user' boundary.
    while (keepRest.length > 0) {
      const head = keepRest[0];
      if (head.role === 'tool') {
        keepRest = keepRest.slice(1);
        continue;
      }
      if (head.role === 'assistant' && head.toolCalls && head.toolCalls.length > 0) {
        keepRest = keepRest.slice(1);
        continue;
      }
      break;
    }
    this.messages = [...system, ...keepRest];
  }
}
