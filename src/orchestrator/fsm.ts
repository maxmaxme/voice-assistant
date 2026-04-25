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
      // Barge-in: user says the wake word while we're talking.
      if (event.type === 'wake') {
        return {
          state: 'listening',
          effects: [{ type: 'stopSpeaking' }, { type: 'startCapture' }],
        };
      }
      // Natural end of the assistant's reply: stay listening for a follow-up
      // (no second wake-word required) — same FSM machinery as a fresh wake.
      if (event.type === 'speechFinished') {
        return { state: 'listening', effects: [{ type: 'startCapture' }] };
      }
      return { state, effects: [] };
  }
}
