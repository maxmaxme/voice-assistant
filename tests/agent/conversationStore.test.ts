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

  it('never leaves a tool message orphaned from its assistant tool_calls', () => {
    // Reproduces the OpenAI "messages with role 'tool' must be a response to
    // a preceeding message with 'tool_calls'" error: trim must not start the
    // history with a tool or assistant-with-tool_calls message.
    const s = new ConversationStore({ idleTimeoutMs: 60_000, maxMessages: 3 });
    s.append({ role: 'system', content: 'sys' });
    s.append({ role: 'user', content: 'u1' });
    s.append({
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'call_1', name: 't', arguments: {} }],
    });
    s.append({ role: 'tool', toolCallId: 'call_1', content: 'ok' });
    s.append({ role: 'assistant', content: 'done1' });
    s.append({ role: 'user', content: 'u2' });
    s.append({
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'call_2', name: 't', arguments: {} }],
    });
    s.append({ role: 'tool', toolCallId: 'call_2', content: 'ok' });
    s.append({ role: 'assistant', content: 'done2' });

    const h = s.history();
    expect(h[0].role).toBe('system');
    // The remaining history must be valid for OpenAI: no tool message
    // without a preceding assistant.tool_calls, and no assistant.tool_calls
    // without its tool replies. The simplest check: walk the messages and
    // make sure every 'tool' is preceded by an assistant carrying tool_calls.
    const seenToolCallIds = new Set<string>();
    for (let i = 0; i < h.length; i++) {
      const m = h[i];
      if (m.role === 'assistant' && m.toolCalls) {
        for (const tc of m.toolCalls) seenToolCallIds.add(tc.id);
      }
      if (m.role === 'tool') {
        expect(seenToolCallIds.has(m.toolCallId!)).toBe(true);
      }
    }
    // And: never start the non-system tail with an orphan tool message.
    const firstNonSystem = h.find((m) => m.role !== 'system');
    expect(firstNonSystem?.role).not.toBe('tool');
  });
});
