import { describe, it, expect, vi } from 'vitest';
import { dispatch } from '../../src/cli/unified.ts';
import { Scheduler } from '../../src/scheduling/scheduler.ts';
import type { CommonDeps, AgentMode } from '../../src/cli/shared.ts';
import type OpenAI from 'openai';
import type { HaMcpClient } from '../../src/mcp/haMcpClient.ts';
import type {
  MemoryStore,
  RemindersAdapter,
  ScheduledActionsAdapter,
  TimersAdapter,
} from '../../src/memory/types.ts';
import type { TelegramSender, TelegramReceiver } from '../../src/telegram/types.ts';
import type { FireSink } from '../../src/scheduling/types.ts';

function makeMemoryStore(): MemoryStore {
  const noopReminders: RemindersAdapter = {
    add: () => {
      throw new Error('not used');
    },
    listPending: () => [],
    listDue: () => [],
    markFired: () => {},
    cancel: () => false,
    get: () => null,
  };
  const noopTimers: TimersAdapter = {
    add: () => {
      throw new Error('not used');
    },
    listActive: () => [],
    listDue: () => [],
    markFired: () => {},
    cancel: () => false,
    get: () => null,
  };
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
    reminders: noopReminders,
    timers: noopTimers,
    scheduledActions: noopScheduledActions,
    close: () => {},
  };
}

function makeDeps(): CommonDeps {
  return {
    config: {
      telegram: { botToken: 'X', allowedChatIds: [42] },
    } as unknown as CommonDeps['config'],
    llm: {} as unknown as OpenAI,
    mcp: {} as unknown as HaMcpClient,
    memory: makeMemoryStore(),
    telegram: {} as unknown as TelegramSender,
    fireSink: { fire: vi.fn(async () => {}) } satisfies FireSink,
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
      wake: vi.fn(async () => {}),
      telegram: vi.fn(async () => {}),
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
      telegram: vi.fn(async () => {}),
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
      telegram: vi.fn(async () => {}),
    };
    await dispatch('wake' as AgentMode, deps, runners);
    expect(runners.wake).toHaveBeenCalledTimes(1);
  });

  it('both mode invokes wake AND telegram concurrently', async () => {
    const deps = makeDeps();
    const wakeStarted = vi.fn();
    const telegramStarted = vi.fn();
    const runners = {
      chat: vi.fn(async () => {}),
      voice: vi.fn(async () => {}),
      wake: vi.fn(async () => {
        wakeStarted();
        await new Promise((r) => setTimeout(r, 5));
      }),
      telegram: vi.fn(async () => {
        telegramStarted();
        await new Promise((r) => setTimeout(r, 5));
      }),
    };
    await dispatch('both' as AgentMode, deps, runners);
    expect(wakeStarted).toHaveBeenCalled();
    expect(telegramStarted).toHaveBeenCalled();
  });

  it('telegram mode invokes runTelegramMode only', async () => {
    const deps = makeDeps();
    const runners = {
      chat: vi.fn(async () => {}),
      voice: vi.fn(async () => {}),
      wake: vi.fn(async () => {}),
      telegram: vi.fn(async () => {}),
    };
    await dispatch('telegram' as AgentMode, deps, runners);
    expect(runners.telegram).toHaveBeenCalledTimes(1);
  });

  it('builds a separate agent per active channel', async () => {
    const deps = makeDeps();
    const runners = {
      chat: vi.fn(async () => {}),
      voice: vi.fn(async () => {}),
      wake: vi.fn(async () => {}),
      telegram: vi.fn(async () => {}),
    };
    await dispatch('wake' as AgentMode, deps, runners);
    expect(deps.buildAgent).toHaveBeenCalledWith('wake');
  });

  it('starts and stops the scheduler around runners', async () => {
    const deps = makeDeps();
    const startSpy = vi.spyOn(Scheduler.prototype, 'start');
    const stopSpy = vi.spyOn(Scheduler.prototype, 'stop');
    const runners = {
      chat: vi.fn(async () => {}),
      voice: vi.fn(async () => {}),
      wake: vi.fn(async () => {}),
      telegram: vi.fn(async () => {}),
    };
    await dispatch('chat' as AgentMode, deps, runners);
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(stopSpy).toHaveBeenCalledTimes(1);
    startSpy.mockRestore();
    stopSpy.mockRestore();
  });
});
