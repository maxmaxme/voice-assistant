import { describe, it, expect, vi } from 'vitest';
import { dispatch } from '../../src/cli/unified.ts';
import { Scheduler } from '../../src/scheduling/scheduler.ts';
import type { CommonDeps } from '../../src/cli/shared.ts';
import type OpenAI from 'openai';
import { SqliteProfileMemory } from '../../src/memory/sqliteProfileMemory.ts';
import { IdentitiesStore } from '../../src/memory/identities.ts';
import { SqliteSettings } from '../../src/settings/sqliteSettings.ts';
import { SqlitePrompts } from '../../src/settings/sqlitePrompts.ts';
import { SqliteIntegrations } from '../../src/integrations/sqliteIntegrations.ts';
import { freshTestDb } from '../memory/helpers.ts';
import type { HaMcpClient } from '../../src/mcp/haMcpClient.ts';
import type { MemoryStore, ScheduledActionsAdapter } from '../../src/memory/types.ts';
import type { TelegramSender, TelegramReceiver } from '../../src/telegram/types.ts';
import type { GoalRunner } from '../../src/scheduling/goalRunner.ts';

function makeMemoryStore(): MemoryStore {
  const noopScheduledActions: ScheduledActionsAdapter = {
    add: () => {
      throw new Error('not used');
    },
    listActiveForOwner: () => [],
    listDue: () => [],
    markFired: () => {},
    markError: () => {},
    cancel: () => false,
    get: () => null,
  };
  const { db } = freshTestDb();
  const profileStore = new SqliteProfileMemory(db);
  const identities = new IdentitiesStore(db);
  return {
    profile: { remember: () => {}, recall: () => ({}), forget: () => {}, close: () => {} },
    profileStore,
    identities,
    scheduledActions: noopScheduledActions,
    telegramSessions: {
      get: () => null,
      save: () => {},
      delete: () => {},
    },
    settings: new SqliteSettings(db),
    prompts: new SqlitePrompts(db),
    integrations: new SqliteIntegrations(db),
    close: () => {},
  };
}

function makeDeps(): CommonDeps {
  return {
    config: {
      telegram: { botToken: 'X' },
    } as unknown as CommonDeps['config'],
    llm: {} as unknown as OpenAI,
    mcp: {} as unknown as HaMcpClient,
    memory: makeMemoryStore(),
    senderFor: () => ({ send: async () => {} }) as TelegramSender,
    goalRunner: { fire: vi.fn(async () => {}) } satisfies GoalRunner,
    haEnabled: true,
    openai: {
      apiKey: 'sk-test',
      model: 'gpt-test',
      reasoningEffort: 'low',
      webSearch: false,
      realtime: { enabled: false, model: 'rt', voice: 'marin', reasoningEffort: 'low' },
    },
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

function makeRunners(): {
  telegram: ReturnType<typeof vi.fn>;
  http: ReturnType<typeof vi.fn>;
} {
  return {
    telegram: vi.fn(async () => {}),
    http: vi.fn(async () => {}),
  };
}

describe('dispatch', () => {
  it('telegram mode invokes runTelegramMode only', async () => {
    const deps = makeDeps();
    const runners = makeRunners();
    await dispatch('telegram', deps, runners as never);
    expect(runners.telegram).toHaveBeenCalledTimes(1);
    expect(runners.http).not.toHaveBeenCalled();
  });

  it('http mode invokes runHttpMode only', async () => {
    const deps = makeDeps();
    const runners = makeRunners();
    await dispatch('http', deps, runners as never);
    expect(runners.http).toHaveBeenCalledTimes(1);
    expect(runners.telegram).not.toHaveBeenCalled();
  });

  it('both mode invokes telegram and http concurrently', async () => {
    const deps = makeDeps();
    const telegramStarted = vi.fn();
    const httpStarted = vi.fn();
    const runners = {
      telegram: vi.fn(async () => {
        telegramStarted();
        await new Promise((r) => setTimeout(r, 5));
      }),
      http: vi.fn(async () => {
        httpStarted();
        await new Promise((r) => setTimeout(r, 5));
      }),
    };
    await dispatch('both', deps, runners as never);
    expect(telegramStarted).toHaveBeenCalled();
    expect(httpStarted).toHaveBeenCalled();
    expect(deps.buildAgent).toHaveBeenCalledWith('telegram');
    expect(deps.buildAgent).toHaveBeenCalledWith('http');
  });

  it('starts and stops the scheduler around runners', async () => {
    const deps = makeDeps();
    const startSpy = vi.spyOn(Scheduler.prototype, 'start');
    const stopSpy = vi.spyOn(Scheduler.prototype, 'stop');
    const runners = makeRunners();
    await dispatch('telegram', deps, runners as never);
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(stopSpy).toHaveBeenCalledTimes(1);
    startSpy.mockRestore();
    stopSpy.mockRestore();
  });
});
