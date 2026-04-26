import { describe, it, expect } from 'vitest';
import { transition } from '../../src/orchestrator/fsm.ts';

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
    const r = transition('thinking', { type: 'agentReplied', text: 'ok', direction: null });
    expect(r.state).toBe('speaking');
    expect(r.effects).toEqual([{ type: 'speak', text: 'ok', direction: null }]);
  });

  it('thinking + agentReplied with direction → speak carries direction', () => {
    const r = transition('thinking', { type: 'agentReplied', text: '', direction: 'on' });
    expect(r.state).toBe('speaking');
    expect(r.effects).toEqual([{ type: 'speak', text: '', direction: 'on' }]);
  });

  it('speaking + speechFinished → idle (default; follow-up disabled)', () => {
    const r = transition('speaking', { type: 'speechFinished' });
    expect(r.state).toBe('idle');
    expect(r.effects).toEqual([]);
  });

  it('speaking + speechFinished → listening when followUp option is on', () => {
    const r = transition('speaking', { type: 'speechFinished' }, { followUp: true });
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

  it('speaking + followUpRequested → listening (always, ignores followUp option)', () => {
    const r1 = transition('speaking', { type: 'followUpRequested' });
    expect(r1.state).toBe('listening');
    expect(r1.effects).toEqual([{ type: 'startCapture' }]);
    const r2 = transition('speaking', { type: 'followUpRequested' }, { followUp: false });
    expect(r2.state).toBe('listening');
    expect(r2.effects).toEqual([{ type: 'startCapture' }]);
  });

  it('error always returns to idle and logs', () => {
    const r = transition('thinking', { type: 'error', message: 'boom' });
    expect(r.state).toBe('idle');
    expect(r.effects[0]).toEqual({ type: 'log', level: 'error', message: 'boom' });
  });
});
