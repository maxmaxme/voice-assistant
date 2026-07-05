import type { PendingToolOutput, TelegramSessionsAdapter } from '../memory/types.ts';

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

/** How long after an `ask` tool call the user's next utterance is still
 *  treated as the answer. After this window, the ask is closed with a
 *  placeholder output and the next message is handled as a new request.
 *  Tuned for voice: the user either replies within a few seconds or
 *  walks away from the conversation. */
export const PENDING_ASK_TTL_MS = 30 * 1000;

export interface SessionPersistence {
  adapter: TelegramSessionsAdapter;
  chatId: number;
}

/** Opaque state captured by {@link Session.consumePendingAsk} so a failed
 *  OpenAI call can put the ask back ({@link Session.restorePendingAsk}) —
 *  the ask is still open on OpenAI's side until a call succeeds. */
export interface PendingAskSnapshot {
  callId: string;
  expiresAt: number | undefined;
  outputs: PendingToolOutput[] | undefined;
}

export type ConsumedPendingAsk =
  | { state: 'none' }
  | {
      /** 'live': the user's next utterance answers the question.
       *  'expired': past the TTL — close the ask with a placeholder and treat
       *  the utterance as a new request. */
      state: 'live' | 'expired';
      callId: string;
      /** Outputs of tools that ran in parallel with the ask last turn; must be
       *  replayed with the ask's output to keep the chain valid. */
      stashed: PendingToolOutput[];
      snapshot: PendingAskSnapshot;
    };

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
  /** When the pending ask should stop being treated as "the user's next
   *  utterance answers this question". After this moment, the next user
   *  message is treated as a fresh request — the ask's call_id is closed
   *  with a placeholder output so the chain stays valid. Unix ms. */
  pendingAskExpiresAt?: number;
  /** Outputs of non-ask tools that were emitted in parallel with an `ask` in
   *  the previous turn. Must be replayed alongside the ask's output on the
   *  next user turn — otherwise OpenAI rejects with "No tool output found". */
  pendingToolOutputs?: PendingToolOutput[];

  constructor(opts: SessionOptions = {}) {
    this.idleTimeoutMs = opts.idleTimeoutMs ?? SESSION_IDLE_TIMEOUT_MS;
    this.persistence = opts.persistence;
    this.now = opts.now ?? (() => Date.now());
    if (this.persistence) {
      const snap = this.persistence.adapter.get(this.persistence.chatId);
      if (snap) {
        this.lastResponseId = snap.lastResponseId;
        this.pendingAskCallId = snap.pendingAskCallId;
        this.pendingAskExpiresAt = snap.pendingAskExpiresAt;
        this.pendingToolOutputs = snap.pendingToolOutputs;
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
      this.pendingAskExpiresAt = undefined;
      this.pendingToolOutputs = undefined;
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

  /** Record an `ask` tool call whose answer is expected on the next turn.
   *  Stamps the TTL from the session clock. Persisted by the commit() that
   *  follows (like every other pending-ask transition — consume/restore stay
   *  in-memory until a turn actually succeeds). */
  setPendingAsk(callId: string, stashed: PendingToolOutput[]): void {
    this.pendingAskCallId = callId;
    this.pendingAskExpiresAt = this.now() + PENDING_ASK_TTL_MS;
    this.pendingToolOutputs = stashed;
  }

  /** Take the pending ask off the session (if any), classifying it against
   *  the TTL. The returned snapshot lets a failed turn restore it. */
  consumePendingAsk(): ConsumedPendingAsk {
    const callId = this.pendingAskCallId;
    if (callId === undefined) {
      return { state: 'none' };
    }
    const snapshot: PendingAskSnapshot = {
      callId,
      expiresAt: this.pendingAskExpiresAt,
      outputs: this.pendingToolOutputs,
    };
    const expired = this.pendingAskExpiresAt !== undefined && this.now() > this.pendingAskExpiresAt;
    this.pendingAskCallId = undefined;
    this.pendingAskExpiresAt = undefined;
    this.pendingToolOutputs = undefined;
    return {
      state: expired ? 'expired' : 'live',
      callId,
      stashed: snapshot.outputs ?? [],
      snapshot,
    };
  }

  /** Undo a consume after the OpenAI call failed — the ask never reached the
   *  API, so it must be answered on the next turn after all. */
  restorePendingAsk(snapshot: PendingAskSnapshot): void {
    this.pendingAskCallId = snapshot.callId;
    this.pendingAskExpiresAt = snapshot.expiresAt;
    this.pendingToolOutputs = snapshot.outputs;
  }

  /** Force a fresh chain on the next call (used by `/reset`). */
  reset(): void {
    this.lastResponseId = undefined;
    this.pendingAskCallId = undefined;
    this.pendingAskExpiresAt = undefined;
    this.pendingToolOutputs = undefined;
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
      pendingAskExpiresAt: this.pendingAskExpiresAt,
      pendingToolOutputs: this.pendingToolOutputs,
    });
  }
}
