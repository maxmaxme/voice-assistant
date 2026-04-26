export type State = 'idle' | 'listening' | 'thinking' | 'speaking';

export type ActionDirection = 'on' | 'off' | 'neutral';

export type Event =
  | { type: 'wake' }
  | { type: 'utteranceEnd'; audio: Buffer }
  | {
      type: 'agentReplied';
      text: string;
      direction: ActionDirection | null;
      expectsFollowUp?: boolean;
    }
  | { type: 'speechFinished' }
  | { type: 'followUpRequested' } // agent called the `ask` tool — auto-reopen capture
  | { type: 'error'; message: string };

export type Effect =
  | { type: 'startCapture' }
  | { type: 'stopSpeaking' }
  | { type: 'transcribeAndAsk'; audio: Buffer }
  | { type: 'speak'; text: string; direction: ActionDirection | null; expectsFollowUp?: boolean }
  | { type: 'log'; level: 'info' | 'error'; message: string };

export interface Transition {
  state: State;
  effects: Effect[];
}
