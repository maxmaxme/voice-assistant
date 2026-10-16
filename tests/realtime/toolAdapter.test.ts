import { describe, it, expect } from 'vitest';
import { toRealtimeTools } from '../../src/realtime/toolAdapter.ts';

describe('toRealtimeTools', () => {
  it('keeps the function-tool shape and drops `strict`, which Realtime does not take', () => {
    const parameters = {
      type: 'object',
      properties: { entity_id: { type: 'string' } },
      required: ['entity_id'],
    };
    const out = toRealtimeTools([
      { type: 'function', name: 'HassTurnOn', description: 'Turn on', parameters, strict: false },
    ]);
    expect(out).toStrictEqual([
      { type: 'function', name: 'HassTurnOn', description: 'Turn on', parameters },
    ]);
  });
});
