import type { State, Event, Transition } from './types.ts';

export interface TransitionOptions {
  /** When true, after the assistant finishes speaking, automatically reopen
   * listening for a follow-up command (no wake-word needed). Default false:
   * acoustic echo from the speakers can leak into the mic and cause the
   * assistant to converse with itself. Safe to enable with headphones. */
  followUp?: boolean;
}

export function transition(
  state: State,
  event: Event,
  options: TransitionOptions = {},
): Transition {
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
        return {
          state: 'speaking',
          effects: [
            {
              type: 'speak',
              text: event.text,
              direction: event.direction,
              expectsFollowUp: event.expectsFollowUp,
            },
          ],
        };
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
      if (event.type === 'speechFinished') {
        // Follow-up listening: only enabled with the option, since speaker
        // echo into the mic otherwise causes the assistant to talk to itself.
        if (options.followUp) {
          return { state: 'listening', effects: [{ type: 'startCapture' }] };
        }
        return { state: 'idle', effects: [] };
      }
      // Agent's reply was a question — always reopen capture, regardless of
      // the followUp option. Self-echo is unlikely to look like an answer to
      // the assistant's specific question, and the UX win is large.
      if (event.type === 'followUpRequested') {
        return { state: 'listening', effects: [{ type: 'startCapture' }] };
      }
      return { state, effects: [] };
  }
}
