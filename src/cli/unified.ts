import {
  initializeCommonDependencies,
  parseAgentMode,
  type AgentMode,
  type CommonDeps,
} from './shared.ts';
import { runChatMode, type ChatRunnerDeps } from './runners/chat.ts';
import { runVoiceMode, type VoiceRunnerDeps } from './runners/voice.ts';
import { runWakeMode, type WakeRunnerDeps } from './runners/wake.ts';
import type { Session } from '../agent/session.ts';
import { OpenAiStt } from '../audio/openaiStt.ts';
import { OpenAiTts } from '../audio/openaiTts.ts';

export interface RunnerSet {
  chat: (deps: ChatRunnerDeps) => Promise<void>;
  voice: (deps: VoiceRunnerDeps) => Promise<void>;
  wake: (deps: WakeRunnerDeps) => Promise<void>;
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

  // mode === 'telegram': stub for Plan 2. No-op so the harness doesn't crash if
  // someone sets AGENT_MODE=telegram before Plan 2 lands.
  if (mode === 'telegram') {
    console.log('[unified] AGENT_MODE=telegram — runner not yet implemented (Plan 2).');
    return;
  }

  if (tasks.length === 0) {
    throw new Error(`No runners scheduled for AGENT_MODE=${mode}`);
  }

  // Promise.race: if any runner crashes/exits, tear down the whole process.
  await Promise.race(tasks);
}

async function main(): Promise<void> {
  const mode = parseAgentMode(process.env.AGENT_MODE);
  console.log(`[unified] AGENT_MODE=${mode}`);

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
