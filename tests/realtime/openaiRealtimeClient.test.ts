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
