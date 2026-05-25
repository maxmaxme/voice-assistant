import { describe, it, expect } from 'vitest';
import {
  parseDeviceMessage,
  encodeServerMessage,
  type ServerMessage,
} from '../../src/realtime/protocol.ts';

describe('protocol', () => {
  it('parses a valid start message', () => {
    const msg = parseDeviceMessage('{"type":"start"}');
    expect(msg).toEqual({ type: 'start' });
  });

  it('parses an interrupt message', () => {
    const msg = parseDeviceMessage('{"type":"interrupt"}');
    expect(msg).toEqual({ type: 'interrupt' });
  });

  it('parses a ping message', () => {
    const msg = parseDeviceMessage('{"type":"ping"}');
    expect(msg).toEqual({ type: 'ping' });
  });

  it('rejects unknown message types', () => {
    expect(() => parseDeviceMessage('{"type":"nope"}')).toThrow();
  });

  it('rejects malformed JSON', () => {
    expect(() => parseDeviceMessage('not json')).toThrow();
  });

  it('encodes a phase message', () => {
    const out: ServerMessage = { type: 'phase', value: 'listening' };
    expect(encodeServerMessage(out)).toBe('{"type":"phase","value":"listening"}');
  });

  it('encodes an error message', () => {
    expect(encodeServerMessage({ type: 'error', message: 'boom' })).toBe(
      '{"type":"error","message":"boom"}',
    );
  });
});
