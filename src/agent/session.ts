import type { TelegramSessionsAdapter } from '../memory/types.ts';

/**
 * Lightweight conversation state for the Responses API.
 *
 * Holds only the `lastResponseId` so we can chain turns via
 * `previous_response_id` — the actual message history lives on OpenAI's
 * side. After an idle window the chain is forgotten and the next turn
 * starts a fresh conversation (with a fresh system prompt / profile).
 *
 * Optionally self-persisting: when constructed with `persistence`, the
 * Session loads its prior state from the adapter at construction time and
 * writes back automatically on every `commit()` / `reset()`. Use this for
 * channels that need to survive process restarts (Telegram).
 */
/** How long a conversation chain stays alive without activity. After
 * this window the next turn starts fresh (new system prompt, no
 * `previous_response_id`). Use Number.POSITIVE_INFINITY to disable. */
export const SESSION_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

export interface SessionPersistence {
  adapter: TelegramSessionsAdapter;
  chatId: number;
}

export interface SessionOptions {
  idleTimeoutMs?: number;
  persistence?: SessionPersistence;
  now?: () => number;
}

export class Session {
  private lastResponseId?: string;
  private lastTouch = 0;
  private readonly idleTimeoutMs: number;
  private readonly persistence?: SessionPersistence;
  private readonly now: () => number;
  /** call_id of a pending `ask` tool call that needs a function_call_output on the next turn. */
  pendingAskCallId?: string;

  constructor(opts: SessionOptions = {}) {
    this.idleTimeoutMs = opts.idleTimeoutMs ?? SESSION_IDLE_TIMEOUT_MS;
    this.persistence = opts.persistence;
    this.now = opts.now ?? (() => Date.now());
    if (this.persistence) {
      const snap = this.persistence.adapter.get(this.persistence.chatId);
      if (snap) {
        this.lastResponseId = snap.lastResponseId;
        this.pendingAskCallId = snap.pendingAskCallId;
      }
    }
  }

  /**
   * Returns the response_id to chain from, or `undefined` if the chain
   * is empty or has gone stale. Also marks this moment as the latest
   * activity so concurrent quick retries don't drop the chain.
   */
  begin(): string | undefined {
    if (this.isStale()) {
      this.lastResponseId = undefined;
      this.pendingAskCallId = undefined;
    }
    this.lastTouch = this.now();
    return this.lastResponseId;
  }

  /** Mark a turn complete — the next turn chains from this id. */
  commit(responseId: string): void {
    this.lastResponseId = responseId;
    this.lastTouch = this.now();
    this.save();
  }

  /** Force a fresh chain on the next call (used by `/reset`). */
  reset(): void {
    this.lastResponseId = undefined;
    this.pendingAskCallId = undefined;
    this.lastTouch = 0;
    if (this.persistence) {
      this.persistence.adapter.delete(this.persistence.chatId);
    }
  }

  /** True when no chain is active (initial state or post-idle). */
  isFresh(): boolean {
    return this.lastResponseId === undefined || this.isStale();
  }

  private isStale(): boolean {
    if (this.lastTouch === 0) {
      return false;
    }
    return this.now() - this.lastTouch >= this.idleTimeoutMs;
  }

  private save(): void {
    if (!this.persistence) {
      return;
    }
    this.persistence.adapter.save(this.persistence.chatId, {
      lastResponseId: this.lastResponseId,
      pendingAskCallId: this.pendingAskCallId,
    });
  }
}
