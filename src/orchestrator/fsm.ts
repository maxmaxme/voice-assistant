import type { State, Event, Transition } from './types.js';

export function transition(state: State, event: Event): Transition {
  if (event.type === 'error') {
    return { state: 'idle', effects: [{ type: 'log', level: 'error', message: event.message }] };
  }
  switch (state) {
    case 'idle':
      if (event.type === 'wake') {
        return { state: 'listening', effects: [{ type: 'startCapture' }] };
      }
      return { state, effects: [] };
    case 'listening':
      if (event.type === 'utteranceEnd') {
        return { state: 'thinking', effects: [{ type: 'transcribeAndAsk', audio: event.audio }] };
      }
      return { state, effects: [] };
    case 'thinking':
      if (event.type === 'agentReplied') {
        return { state: 'speaking', effects: [{ type: 'speak', text: event.text }] };
      }
      return { state, effects: [] };
    case 'speaking':
      if (event.type === 'speechFinished') {
        return { state: 'idle', effects: [] };
      }
      return { state, effects: [] };
  }
}
