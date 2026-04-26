import { describe, it, expect, vi } from 'vitest';
import { dispatch } from '../../src/cli/unified.ts';
import type { CommonDeps, AgentMode } from '../../src/cli/shared.ts';
import type { Config } from '../../src/config.ts';
import type OpenAI from 'openai';
import type { HaMcpClient } from '../../src/mcp/haMcpClient.ts';
import type { SqliteProfileMemory } from '../../src/memory/sqliteProfileMemory.ts';
import type { TelegramSender } from '../../src/telegram/types.ts';
import type { OpenAiAgent } from '../../src/agent/openaiAgent.ts';

function makeDeps(): CommonDeps {
  return {
    config: {} as unknown as Config,
    llm: {} as unknown as OpenAI,
    mcp: {} as unknown as HaMcpClient,
    memory: {} as unknown as SqliteProfileMemory,
    telegram: {} as unknown as TelegramSender,
    buildAgent: vi.fn(() => ({}) as unknown as OpenAiAgent),
    dispose: vi.fn(async () => {}),
  };
}

describe('dispatch', () => {
  it('chat mode invokes runChatMode once', async () => {
    const deps = makeDeps();
    const runners = {
      chat: vi.fn(async () => {}),
      voice: vi.fn(async () => {}),
      wake: vi.fn(async () => {}),
    };
    await dispatch('chat' as AgentMode, deps, runners);
    expect(runners.chat).toHaveBeenCalledTimes(1);
    expect(runners.voice).not.toHaveBeenCalled();
    expect(runners.wake).not.toHaveBeenCalled();
  });

  it('voice mode invokes runVoiceMode only', async () => {
    const deps = makeDeps();
    const runners = {
      chat: vi.fn(async () => {}),
      voice: vi.fn(async () => {}),
      wake: vi.fn(async () => {}),
    };
    await dispatch('voice' as AgentMode, deps, runners);
    expect(runners.voice).toHaveBeenCalledTimes(1);
  });

  it('wake mode invokes runWakeMode only', async () => {
    const deps = makeDeps();
    const runners = {
      chat: vi.fn(async () => {}),
      voice: vi.fn(async () => {}),
      wake: vi.fn(async () => {}),
    };
    await dispatch('wake' as AgentMode, deps, runners);
    expect(runners.wake).toHaveBeenCalledTimes(1);
  });

  it('both mode invokes wake (telegram added in Plan 2)', async () => {
    const deps = makeDeps();
    const runners = {
      chat: vi.fn(async () => {}),
      voice: vi.fn(async () => {}),
      wake: vi.fn(async () => {}),
    };
    await dispatch('both' as AgentMode, deps, runners);
    expect(runners.wake).toHaveBeenCalledTimes(1);
  });

  it('telegram mode is a no-op stub until Plan 2 (does not throw)', async () => {
    const deps = makeDeps();
    const runners = {
      chat: vi.fn(async () => {}),
      voice: vi.fn(async () => {}),
      wake: vi.fn(async () => {}),
    };
    await expect(dispatch('telegram' as AgentMode, deps, runners)).resolves.toBeUndefined();
  });

  it('builds a separate agent per active channel', async () => {
    const deps = makeDeps();
    const runners = {
      chat: vi.fn(async () => {}),
      voice: vi.fn(async () => {}),
      wake: vi.fn(async () => {}),
    };
    await dispatch('wake' as AgentMode, deps, runners);
    expect(deps.buildAgent).toHaveBeenCalledWith('wake');
  });
});
