import 'dotenv/config';

import {
  initializeCommonDependencies,
  parseAgentMode,
  type AgentMode,
  type CommonDeps,
} from './shared.ts';
import { runChatMode, type ChatRunnerDeps } from './runners/chat.ts';
import { runVoiceMode, type VoiceRunnerDeps } from './runners/voice.ts';
import { runWakeMode, type WakeRunnerDeps } from './runners/wake.ts';
import { runTelegramMode, perChatSender, type TelegramRunnerDeps } from './runners/telegram.ts';
import { runHttpMode, type HttpRunnerDeps } from './runners/http.ts';
import { Session } from '../agent/session.ts';
import { OpenAiStt } from '../audio/openaiStt.ts';
import { OpenAiTts } from '../audio/openaiTts.ts';
import { ElevenLabsTts } from '../audio/elevenlabsTts.ts';
import type { Tts } from '../audio/types.ts';
import { BotVoiceTranscriber } from '../telegram/voiceTranscriber.ts';
import { BotPhotoLoader } from '../telegram/photoLoader.ts';
import { Scheduler } from '../scheduling/scheduler.ts';
import { getServerTimezone } from '../utils/time.ts';
import { createLogger } from '../utils/logger.ts';

const log = createLogger('unified');

export interface RunnerSet {
  chat: (deps: ChatRunnerDeps) => Promise<void>;
  voice: (deps: VoiceRunnerDeps) => Promise<void>;
  wake: (deps: WakeRunnerDeps) => Promise<void>;
  telegram: (deps: TelegramRunnerDeps) => Promise<void>;
  http: (deps: HttpRunnerDeps) => Promise<void>;
}

function buildTts(llm: import('openai').default): Tts {
  if (process.env.TTS_PROVIDER === 'elevenlabs') {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
      throw new Error('TTS_PROVIDER=elevenlabs but ELEVENLABS_API_KEY is not set');
    }
    return new ElevenLabsTts({
      apiKey,
      voiceId: process.env.ELEVENLABS_VOICE_ID,
    });
  }
  return new OpenAiTts({ client: llm });
}

/** Dispatch logic, exported for tests. Does NOT call initializeCommonDependencies
 * — the caller passes deps so tests can use mocks. */
export async function dispatch(
  mode: AgentMode,
  deps: CommonDeps,
  runners: RunnerSet,
): Promise<void> {
  const tasks: Promise<void>[] = [];

  if (mode === 'chat') {
    const agent = deps.buildAgent('chat');
    tasks.push(
      runners.chat({
        agent,
        session: agent.session,
        memory: deps.memory,
      }),
    );
  }

  if (mode === 'voice') {
    const agent = deps.buildAgent('voice');
    tasks.push(
      runners.voice({
        agent,
        stt: new OpenAiStt({ client: deps.llm }),
        tts: buildTts(deps.llm),
      }),
    );
  }

  if (mode === 'wake' || mode === 'both') {
    const agent = deps.buildAgent('wake');
    tasks.push(
      runners.wake({ agent, llm: deps.llm, config: deps.config, tts: buildTts(deps.llm) }),
    );
  }

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
    const port = parseInt(process.env.HTTP_SERVER_PORT ?? '3000', 10);
    tasks.push(
      runners.http({
        agent,
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
      chat: runChatMode,
      voice: runVoiceMode,
      wake: runWakeMode,
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
