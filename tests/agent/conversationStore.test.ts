import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConversationStore } from '../../src/agent/conversationStore.js';

describe('ConversationStore', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('stores and returns messages', () => {
    const s = new ConversationStore({ idleTimeoutMs: 60_000, maxMessages: 20 });
    s.append({ role: 'user', content: 'hi' });
    s.append({ role: 'assistant', content: 'hello' });
    expect(s.history()).toHaveLength(2);
  });

  it('clears history after idle timeout since last append', () => {
    const s = new ConversationStore({ idleTimeoutMs: 1000, maxMessages: 20 });
    s.append({ role: 'user', content: 'hi' });
    vi.advanceTimersByTime(500);
    s.append({ role: 'assistant', content: 'hello' });
    vi.advanceTimersByTime(1001);
    expect(s.history()).toHaveLength(0);
  });

  it('does not clear when accessed within timeout', () => {
    const s = new ConversationStore({ idleTimeoutMs: 1000, maxMessages: 20 });
    s.append({ role: 'user', content: 'hi' });
    vi.advanceTimersByTime(999);
    expect(s.history()).toHaveLength(1);
  });

  it('trims oldest non-system messages over maxMessages', () => {
    const s = new ConversationStore({ idleTimeoutMs: 60_000, maxMessages: 3 });
    s.append({ role: 'system', content: 'sys' });
    s.append({ role: 'user', content: 'm1' });
    s.append({ role: 'user', content: 'm2' });
    s.append({ role: 'user', content: 'm3' });
    s.append({ role: 'user', content: 'm4' });
    const h = s.history();
    expect(h[0].content).toBe('sys');
    expect(h.map((m) => m.content)).toEqual(['sys', 'm3', 'm4']);
  });

  it('reset() clears immediately', () => {
    const s = new ConversationStore({ idleTimeoutMs: 60_000, maxMessages: 20 });
    s.append({ role: 'user', content: 'hi' });
    s.reset();
    expect(s.history()).toHaveLength(0);
  });
});
