import { describe, it, expect } from 'vitest';
import { OpenAiRealtimeClient } from '../../src/realtime/openaiRealtimeClient.ts';

function makeClient(): OpenAiRealtimeClient {
  return new OpenAiRealtimeClient({
    apiKey: 'test-key',
    model: 'gpt-realtime-2',
    instructions: 'be brief',
    voice: 'marin',
    tools: [],
  });
}

describe('OpenAiRealtimeClient.cancelResponse', () => {
  it('is a no-op when the ws is not open (lazy-disconnected session)', () => {
    const client = makeClient();
    // Never connected → ws is null. A device `start`/`interrupt` can legitimately
    // arrive while the upstream is lazily disconnected (fresh wake after the
    // idle-reset or OpenAI's 30-min cap). There is no response to cancel, and
    // throwing here used to abort the bridge's control handler — dropping the
    // listening phase and logging "bad device control message".
    expect(() => client.cancelResponse()).not.toThrow();
  });
});

describe('OpenAiRealtimeClient tool-result paths on a closed ws', () => {
  // The OpenAI ws can race a close (30-min cap, network drop) while a tool
  // batch is in flight. These are called from the bridge's response.done
  // handler — a throw there would strand the device in the thinking phase
  // until its own timeout. Like cancelResponse, they must degrade to no-ops.
  it('submitToolResult is a no-op when the ws is not open', () => {
    const client = makeClient();
    expect(() => client.submitToolResult('call_1', '{}')).not.toThrow();
  });

  it('requestResponse is a no-op when the ws is not open', () => {
    const client = makeClient();
    expect(() => client.requestResponse()).not.toThrow();
  });
});
