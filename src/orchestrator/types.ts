export type State = 'idle' | 'listening' | 'thinking' | 'speaking';

export type Event =
  | { type: 'wake' }
  | { type: 'utteranceEnd'; audio: Buffer }
  | { type: 'agentReplied'; text: string }
  | { type: 'speechFinished' }
  | { type: 'followUpRequested' }   // agent reply was a question — auto-reopen capture
  | { type: 'error'; message: string };

export type Effect =
  | { type: 'startCapture' }
  | { type: 'stopSpeaking' }
  | { type: 'transcribeAndAsk'; audio: Buffer }
  | { type: 'speak'; text: string }
  | { type: 'log'; level: 'info' | 'error'; message: string };

export interface Transition {
  state: State;
  effects: Effect[];
}
