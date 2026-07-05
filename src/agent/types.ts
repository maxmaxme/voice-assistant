import type { Session } from './session.ts';
import type { Scope, ScopedProfile } from '../memory/scope.ts';

export interface AgentResponse {
  text: string;
  /** True when the agent is asking the user a clarifying question and
   * expects an immediate verbal answer (set when the LLM calls the `ask`
   * tool). */
  expectsFollowUp?: boolean;
  /** Names of tools the agent invoked during this turn, in call order.
   * Empty when the agent answered with plain text only. Used by goal-mode
   * callers to detect "goal returned text but never reached the user". */
  toolsUsed?: string[];
}

export interface AgentImage {
  /** Raw image bytes. */
  data: Buffer;
  /** MIME type, e.g. "image/jpeg" or "image/png". */
  mimeType: string;
}

export interface AgentRespondOptions {
  /** Optional images to attach to the user message (multimodal input). */
  images?: AgentImage[];
  /** Per-call session override. Lets callers swap in a per-conversation
   * Session (e.g. one per Telegram chat) without rebuilding the agent. */
  session?: Session;
  /** Per-call scope for the profile. Used for BOTH memory-tool execution
   * and the profile facts injected into the system prompt. When omitted,
   * the agent falls back to a household view of its own MemoryAdapter. */
  profile?: ScopedProfile;
  /** The resolved principal for this call. Threaded into owner-aware tools
   * (scheduled actions: author of new reminders, owner-scoped list/cancel).
   * Omitted on goal-mode fires and other unscoped callers. */
  scope?: Scope;
  /** Called with each output-text delta as the model generates it. Fires on
   * EVERY tool-loop iteration, including ones that end in tool calls — the
   * caller shows deltas as an ephemeral draft and replaces it with the final
   * text, so stray pre-tool-call text is harmless. */
  onTextDelta?: (delta: string) => void;
}

export interface Agent {
  respond(userText: string, opts?: AgentRespondOptions): Promise<AgentResponse>;
}
