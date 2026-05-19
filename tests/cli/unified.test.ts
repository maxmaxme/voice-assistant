import { describe, it, expect, vi } from 'vitest';
import { dispatch } from '../../src/cli/unified.ts';
import { Scheduler } from '../../src/scheduling/scheduler.ts';
import type { CommonDeps } from '../../src/cli/shared.ts';
import type OpenAI from 'openai';
import type { HaMcpClient } from '../../src/mcp/haMcpClient.ts';
import type { MemoryStore, ScheduledActionsAdapter } from '../../src/memory/types.ts';
import type { TelegramSender, TelegramReceiver } from '../../src/telegram/types.ts';
import type { GoalRunner } from '../../src/scheduling/goalRunner.ts';

function makeMemoryStore(): MemoryStore {
  const noopScheduledActions: ScheduledActionsAdapter = {
    add: () => {
      throw new Error('not used');
    },
    listActive: () => [],
    listDue: () => [],
    markFired: () => {},
    markError: () => {},
    cancel: () => false,
    get: () => null,
  };
  return {
    profile: { remember: () => {}, recall: () => ({}), forget: () => {}, close: () => {} },
    scheduledActions: noopScheduledActions,
    telegramSessions: {
      get: () => null,
      save: () => {},
      delete: () => {},
    },
    close: () => {},
  };
}

function makeDeps(): CommonDeps {
  return {
    config: {
      telegram: { botToken: 'X', allowedChatIds: [42] },
      http: { apiKeys: ['test-key'] },
    } as unknown as CommonDeps['config'],
    llm: {} as unknown as OpenAI,
    mcp: {} as unknown as HaMcpClient,
    memory: makeMemoryStore(),
    telegram: {} as unknown as TelegramSender,
    goalRunner: { fire: vi.fn(async () => {}) } satisfies GoalRunner,
    buildAgent: vi.fn(
      () =>
        ({ opts: { session: { reset: vi.fn() } } }) as unknown as ReturnType<
          CommonDeps['buildAgent']
        >,
    ),
    dispose: vi.fn(async () => {}),
    telegramReceiver: vi.fn(
      (): TelegramReceiver => ({
        messages: async function* () {},
        stop: vi.fn(async () => {}),
      }),
    ),
  };
}

describe('dispatch', () => {
  it('chat mode invokes runChatMode once', async () => {
    const deps = makeDeps();
    const runners = {
      chat: vi.fn(async () => {}),
      voice: vi.fn(async () => {}),
      voiceRealtime: vi.fn(async () => {}),
      wakeRealtime: vi.fn(async () => {}),
      wake: vi.fn(async () => {}),
      telegram: vi.fn(async () => {}),
      http: vi.fn(async () => {}),
    };
    await dispatch('chat', deps, runners);
    expect(runners.chat).toHaveBeenCalledTimes(1);
    expect(runners.voice).not.toHaveBeenCalled();
    expect(runners.wake).not.toHaveBeenCalled();
  });

  it('voice mode invokes runVoiceMode only', async () => {
    const deps = makeDeps();
    const runners = {
      chat: vi.fn(async () => {}),
      voice: vi.fn(async () => {}),
      voiceRealtime: vi.fn(async () => {}),
      wakeRealtime: vi.fn(async () => {}),
      wake: vi.fn(async () => {}),
      telegram: vi.fn(async () => {}),
      http: vi.fn(async () => {}),
    };
    const prev = process.env.VOICE_REALTIME;
    delete process.env.VOICE_REALTIME;
    try {
      await dispatch('voice', deps, runners);
    } finally {
      if (prev !== undefined) {
        process.env.VOICE_REALTIME = prev;
      }
    }
    expect(runners.voice).toHaveBeenCalledTimes(1);
    expect(runners.voiceRealtime).not.toHaveBeenCalled();
  });

  it('voice mode invokes runVoiceRealtimeMode when VOICE_REALTIME=1', async () => {
    const deps = makeDeps();
    deps.config = {
      ...deps.config,
      openai: { apiKey: 'sk-test', model: 'gpt-4o' },
    } as unknown as CommonDeps['config'];
    const runners = {
      chat: vi.fn(async () => {}),
      voice: vi.fn(async () => {}),
      voiceRealtime: vi.fn(async () => {}),
      wakeRealtime: vi.fn(async () => {}),
      wake: vi.fn(async () => {}),
      telegram: vi.fn(async () => {}),
      http: vi.fn(async () => {}),
    };
    const prev = process.env.VOICE_REALTIME;
    process.env.VOICE_REALTIME = '1';
    try {
      await dispatch('voice', deps, runners);
    } finally {
      if (prev === undefined) {
        delete process.env.VOICE_REALTIME;
      } else {
        process.env.VOICE_REALTIME = prev;
      }
    }
    expect(runners.voiceRealtime).toHaveBeenCalledTimes(1);
    expect(runners.voice).not.toHaveBeenCalled();
    const call = (
      runners.voiceRealtime.mock.calls as unknown as Array<
        [{ apiKey: string; model: string; systemPrompt: string }]
      >
    )[0]?.[0];
    expect(call?.apiKey).toBe('sk-test');
    expect(call?.model).toBeTruthy();
    expect(call?.systemPrompt).toContain('You are');
  });

  it('wake mode invokes runWakeMode only', async () => {
    const deps = makeDeps();
    const runners = {
      chat: vi.fn(async () => {}),
      voice: vi.fn(async () => {}),
      voiceRealtime: vi.fn(async () => {}),
      wakeRealtime: vi.fn(async () => {}),
      wake: vi.fn(async () => {}),
      telegram: vi.fn(async () => {}),
      http: vi.fn(async () => {}),
    };
    const prev = process.env.WAKE_REALTIME;
    delete process.env.WAKE_REALTIME;
    try {
      await dispatch('wake', deps, runners);
    } finally {
      if (prev !== undefined) {
        process.env.WAKE_REALTIME = prev;
      }
    }
    expect(runners.wake).toHaveBeenCalledTimes(1);
    expect(runners.wakeRealtime).not.toHaveBeenCalled();
  });

  it('wake mode invokes runWakeRealtimeMode when WAKE_REALTIME=1', async () => {
    const deps = makeDeps();
    deps.config = {
      ...deps.config,
      openai: { apiKey: 'sk-test', model: 'gpt-4o' },
      wakeWord: { keyword: 'hey_jarvis' },
    } as unknown as CommonDeps['config'];
    const runners = {
      chat: vi.fn(async () => {}),
      voice: vi.fn(async () => {}),
      voiceRealtime: vi.fn(async () => {}),
      wakeRealtime: vi.fn(async () => {}),
      wake: vi.fn(async () => {}),
      telegram: vi.fn(async () => {}),
      http: vi.fn(async () => {}),
    };
    const prev = process.env.WAKE_REALTIME;
    process.env.WAKE_REALTIME = '1';
    try {
      await dispatch('wake', deps, runners);
    } finally {
      if (prev === undefined) {
        delete process.env.WAKE_REALTIME;
      } else {
        process.env.WAKE_REALTIME = prev;
      }
    }
    expect(runners.wakeRealtime).toHaveBeenCalledTimes(1);
    expect(runners.wake).not.toHaveBeenCalled();
  });

  it('both mode invokes wake, telegram, and http concurrently', async () => {
    const deps = makeDeps();
    const wakeStarted = vi.fn();
    const telegramStarted = vi.fn();
    const httpStarted = vi.fn();
    const runners = {
      chat: vi.fn(async () => {}),
      voice: vi.fn(async () => {}),
      voiceRealtime: vi.fn(async () => {}),
      wakeRealtime: vi.fn(async () => {}),
      wake: vi.fn(async () => {
        wakeStarted();
        await new Promise((r) => setTimeout(r, 5));
      }),
      telegram: vi.fn(async () => {
        telegramStarted();
        await new Promise((r) => setTimeout(r, 5));
      }),
      http: vi.fn(async () => {
        httpStarted();
        await new Promise((r) => setTimeout(r, 5));
      }),
    };
    const prevWake = process.env.WAKE_REALTIME;
    delete process.env.WAKE_REALTIME;
    try {
      await dispatch('both', deps, runners);
    } finally {
      if (prevWake !== undefined) {
        process.env.WAKE_REALTIME = prevWake;
      }
    }
    expect(wakeStarted).toHaveBeenCalled();
    expect(telegramStarted).toHaveBeenCalled();
    expect(httpStarted).toHaveBeenCalled();
    expect(deps.buildAgent).toHaveBeenCalledWith('wake');
    expect(deps.buildAgent).toHaveBeenCalledWith('telegram');
    expect(deps.buildAgent).toHaveBeenCalledWith('http');
  });

  it('telegram mode invokes runTelegramMode only', async () => {
    const deps = makeDeps();
    const runners = {
      chat: vi.fn(async () => {}),
      voice: vi.fn(async () => {}),
      voiceRealtime: vi.fn(async () => {}),
      wakeRealtime: vi.fn(async () => {}),
      wake: vi.fn(async () => {}),
      telegram: vi.fn(async () => {}),
      http: vi.fn(async () => {}),
    };
    await dispatch('telegram', deps, runners);
    expect(runners.telegram).toHaveBeenCalledTimes(1);
  });

  it('builds a separate agent per active channel', async () => {
    const deps = makeDeps();
    const runners = {
      chat: vi.fn(async () => {}),
      voice: vi.fn(async () => {}),
      voiceRealtime: vi.fn(async () => {}),
      wakeRealtime: vi.fn(async () => {}),
      wake: vi.fn(async () => {}),
      telegram: vi.fn(async () => {}),
      http: vi.fn(async () => {}),
    };
    const prev2 = process.env.WAKE_REALTIME;
    delete process.env.WAKE_REALTIME;
    try {
      await dispatch('wake', deps, runners);
    } finally {
      if (prev2 !== undefined) {
        process.env.WAKE_REALTIME = prev2;
      }
    }
    expect(deps.buildAgent).toHaveBeenCalledWith('wake');
  });

  it('starts and stops the scheduler around runners', async () => {
    const deps = makeDeps();
    const startSpy = vi.spyOn(Scheduler.prototype, 'start');
    const stopSpy = vi.spyOn(Scheduler.prototype, 'stop');
    const runners = {
      chat: vi.fn(async () => {}),
      voice: vi.fn(async () => {}),
      voiceRealtime: vi.fn(async () => {}),
      wakeRealtime: vi.fn(async () => {}),
      wake: vi.fn(async () => {}),
      telegram: vi.fn(async () => {}),
      http: vi.fn(async () => {}),
    };
    await dispatch('chat', deps, runners);
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(stopSpy).toHaveBeenCalledTimes(1);
    startSpy.mockRestore();
    stopSpy.mockRestore();
  });
});
