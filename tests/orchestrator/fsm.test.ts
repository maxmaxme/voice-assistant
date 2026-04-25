import { describe, it, expect } from 'vitest';
import { transition } from '../../src/orchestrator/fsm.js';

describe('FSM', () => {
  it('idle + wake → listening with startCapture', () => {
    const r = transition('idle', { type: 'wake' });
    expect(r.state).toBe('listening');
    expect(r.effects).toEqual([{ type: 'startCapture' }]);
  });

  it('listening + utteranceEnd → thinking with transcribeAndAsk', () => {
    const audio = Buffer.from([1, 2, 3]);
    const r = transition('listening', { type: 'utteranceEnd', audio });
    expect(r.state).toBe('thinking');
    expect(r.effects).toEqual([{ type: 'transcribeAndAsk', audio }]);
  });

  it('thinking + agentReplied → speaking with speak', () => {
    const r = transition('thinking', { type: 'agentReplied', text: 'ok' });
    expect(r.state).toBe('speaking');
    expect(r.effects).toEqual([{ type: 'speak', text: 'ok' }]);
  });

  it('speaking + speechFinished → listening (follow-up window)', () => {
    const r = transition('speaking', { type: 'speechFinished' });
    expect(r.state).toBe('listening');
    expect(r.effects).toEqual([{ type: 'startCapture' }]);
  });

  it('speaking + wake → listening (barge-in: stop TTS and start capture)', () => {
    const r = transition('speaking', { type: 'wake' });
    expect(r.state).toBe('listening');
    expect(r.effects).toEqual([{ type: 'stopSpeaking' }, { type: 'startCapture' }]);
  });

  it('wake during listening or thinking is still ignored', () => {
    for (const s of ['listening', 'thinking'] as const) {
      const r = transition(s, { type: 'wake' });
      expect(r.state).toBe(s);
      expect(r.effects).toEqual([]);
    }
  });

  it('error always returns to idle and logs', () => {
    const r = transition('thinking', { type: 'error', message: 'boom' });
    expect(r.state).toBe('idle');
    expect(r.effects[0]).toEqual({ type: 'log', level: 'error', message: 'boom' });
  });
});
