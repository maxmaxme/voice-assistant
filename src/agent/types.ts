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
  /** True when the agent is asking the user a clarifying question and
   * expects an immediate verbal answer (set when the LLM calls the `ask`
   * tool, or as a fallback when the reply text ends with a question mark). */
  expectsFollowUp?: boolean;
}

export interface Agent {
  respond(userText: string): Promise<AgentResponse>;
}
