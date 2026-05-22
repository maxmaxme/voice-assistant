import 'dotenv/config';

import {
  initializeCommonDependencies,
  parseAgentMode,
  type AgentMode,
  type CommonDeps,
} from './shared.ts';
import { runTelegramMode, perChatSender, type TelegramRunnerDeps } from './runners/telegram.ts';
import { runHttpMode, type HttpRunnerDeps } from './runners/http.ts';
import { Session } from '../agent/session.ts';
import { OpenAiStt } from '../audio/openaiStt.ts';
import { BotVoiceTranscriber } from '../telegram/voiceTranscriber.ts';
import { BotPhotoLoader } from '../telegram/photoLoader.ts';
import { Scheduler } from '../scheduling/scheduler.ts';
import { getServerTimezone } from '../utils/time.ts';
import { createLogger } from '../utils/logger.ts';

const log = createLogger('unified');

export interface RunnerSet {
  telegram: (deps: TelegramRunnerDeps) => Promise<void>;
  http: (deps: HttpRunnerDeps) => Promise<void>;
}

/** Dispatch logic, exported for tests. Does NOT call initializeCommonDependencies
 * — the caller passes deps so tests can use mocks. */
export async function dispatch(
  mode: AgentMode,
  deps: CommonDeps,
  runners: RunnerSet,
): Promise<void> {
  const tasks: Promise<void>[] = [];

  if (mode === 'telegram' || mode === 'both') {
    const agent = deps.buildAgent('telegram');
    // Per-chat self-persisting Sessions. No client-side TTL — when OpenAI
    // eventually evicts a stale `previous_response_id` (currently after
    // ~30 days), `OpenAiAgent.respond` catches the 404, resets the chain,
    // and retries the turn fresh.
    const sessionCache = new Map<number, Session>();
    const sessionFor = (chatId: number): Session => {
      let s = sessionCache.get(chatId);
      if (!s) {
        s = new Session({
          idleTimeoutMs: Number.POSITIVE_INFINITY,
          persistence: { adapter: deps.memory.telegramSessions, chatId },
        });
        sessionCache.set(chatId, s);
      }
      return s;
    };
    tasks.push(
      runners.telegram({
        receiver: deps.telegramReceiver(),
        sender: deps.telegram,
        agent,
        sessionFor,
        memory: deps.memory,
        allowedChatIds: deps.config.telegram.allowedChatIds,
        replyTo: perChatSender(deps.config.telegram.botToken),
        voiceTranscriber: new BotVoiceTranscriber({
          botToken: deps.config.telegram.botToken,
          stt: new OpenAiStt({ client: deps.llm }),
        }),
        photoLoader: new BotPhotoLoader({
          botToken: deps.config.telegram.botToken,
        }),
      }),
    );
  }

  if (mode === 'http' || mode === 'both') {
    const agent = deps.buildAgent('http');
    const assistAgent = deps.buildAgent('assist');
    const port = parseInt(process.env.HTTP_SERVER_PORT ?? '3000', 10);
    tasks.push(
      runners.http({
        agent,
        assistAgent,
        stt: new OpenAiStt({ client: deps.llm }),
        port,
        apiKeys: deps.config.http.apiKeys,
      }),
    );
  }

  if (tasks.length === 0) {
    throw new Error(`No runners scheduled for AGENT_MODE=${mode}`);
  }

  const scheduler = new Scheduler({
    scheduledActions: deps.memory.scheduledActions,
    goalRunner: deps.goalRunner,
  });
  scheduler.start();
  try {
    // Promise.race: if any runner crashes/exits, tear down the whole process.
    await Promise.race(tasks);
  } finally {
    scheduler.stop();
  }
}

export async function main(): Promise<void> {
  const mode = parseAgentMode(process.env.AGENT_MODE);
  const webSearch = process.env.OPENAI_WEB_SEARCH === '1' ? ' WEB_SEARCH=on' : '';
  log.info(
    { mode, tz: getServerTimezone(), webSearch: process.env.OPENAI_WEB_SEARCH === '1' },
    `AGENT_MODE=${mode} TZ=${getServerTimezone()}${webSearch}`,
  );

  const deps = await initializeCommonDependencies();

  const onShutdown = async (signal: string): Promise<void> => {
    log.info({ signal }, `received ${signal}, shutting down`);
    await deps.dispose();
    process.exit(0);
  };
  process.on('SIGINT', () => void onShutdown('SIGINT'));
  process.on('SIGTERM', () => void onShutdown('SIGTERM'));

  try {
    await dispatch(mode, deps, {
      telegram: runTelegramMode,
      http: runHttpMode,
    });
  } finally {
    await deps.dispose();
  }
}

// Only run main() when this file is the entry point. The test imports
// `dispatch` directly without triggering main().
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    log.fatal({ err }, 'fatal error in main');
    process.exit(1);
  });
}
