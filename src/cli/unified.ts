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
import type { Session } from '../agent/session.ts';
import { OpenAiStt } from '../audio/openaiStt.ts';
import { OpenAiTts } from '../audio/openaiTts.ts';
import { BotVoiceTranscriber } from '../telegram/voiceTranscriber.ts';
import { Scheduler } from '../scheduling/scheduler.ts';
import { getServerTimezone } from '../utils/time.ts';

export interface RunnerSet {
  chat: (deps: ChatRunnerDeps) => Promise<void>;
  voice: (deps: VoiceRunnerDeps) => Promise<void>;
  wake: (deps: WakeRunnerDeps) => Promise<void>;
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

  if (mode === 'chat') {
    const agent = deps.buildAgent('chat');
    tasks.push(
      runners.chat({
        agent,
        session: (agent as unknown as { opts?: { session: Session } }).opts?.session as Session,
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
        tts: new OpenAiTts({ client: deps.llm }),
      }),
    );
  }

  if (mode === 'wake' || mode === 'both') {
    const agent = deps.buildAgent('wake');
    tasks.push(runners.wake({ agent, llm: deps.llm, config: deps.config }));
  }

  if (mode === 'telegram' || mode === 'both') {
    const agent = deps.buildAgent('telegram');
    const session = (agent as unknown as { opts?: { session: Session } }).opts?.session;
    if (!session) {
      throw new Error('buildAgent did not produce an agent with a Session');
    }
    tasks.push(
      runners.telegram({
        receiver: deps.telegramReceiver(),
        sender: deps.telegram,
        agent,
        session,
        memory: deps.memory,
        allowedChatIds: deps.config.telegram.allowedChatIds,
        replyTo: perChatSender(deps.config.telegram.botToken),
        voiceTranscriber: new BotVoiceTranscriber({
          botToken: deps.config.telegram.botToken,
          stt: new OpenAiStt({ client: deps.llm }),
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
        session: (agent as unknown as { opts?: { session: Session } }).opts?.session as Session,
        memory: deps.memory,
        port,
        config: deps.config,
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
  console.log(`[unified] AGENT_MODE=${mode} TZ=${getServerTimezone()}${webSearch}`);

  const deps = await initializeCommonDependencies();

  const onShutdown = async (signal: string): Promise<void> => {
    console.log(`[unified] received ${signal}, shutting down`);
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
    console.error(err);
    process.exit(1);
  });
}
