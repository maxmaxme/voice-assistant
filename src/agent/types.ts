export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface Message {
  role: Role;
  content: string;
  toolCallId?: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }>;
}

export interface AgentResponse {
  text: string;
  /** Direction of the audio chime when text is empty (silent device confirm).
   * null when text should be spoken aloud. */
  direction: 'on' | 'off' | 'neutral' | null;
  /** True when the agent is asking the user a clarifying question and
   * expects an immediate verbal answer (set when the LLM calls the `ask`
   * tool). */
  expectsFollowUp?: boolean;
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
}

export interface Agent {
  respond(userText: string, opts?: AgentRespondOptions): Promise<AgentResponse>;
}
