import 'dotenv/config';

import {
  initializeCommonDependencies,
  parseAgentMode,
  buildSystemPromptFor,
  type AgentMode,
  type CommonDeps,
} from './shared.ts';
import { runTelegramMode, perChatSender, type TelegramRunnerDeps } from './runners/telegram.ts';
import { runHttpMode, type HttpRunnerDeps } from './runners/http.ts';
import { startRealtimeServer, type RealtimeServer } from '../realtime/index.ts';
import { mcpToolsToRealtime, type RealtimeTool } from '../realtime/toolAdapter.ts';
import { WEATHER_TOOL_NAME, buildWeatherTool, executeWeatherTool } from '../agent/weatherTool.ts';
import { ToolResultCache, CACHEABLE_TOOLS } from '../realtime/toolCache.ts';
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
    // Per-conversation Sessions for `/assist`. 60s idle is short enough
    // that an unrelated utterance after a pause starts a fresh chain
    // (avoiding the "still thinks we're talking about X" leak), and long
    // enough that natural follow-ups inside a single dialog still chain.
    // In-memory only: 60s is far shorter than any restart cadence, so
    // SQLite persistence would buy nothing.
    const ASSIST_SESSION_IDLE_MS = 60 * 1000;
    type Entry = { session: Session; lastTouch: number };
    const assistSessions = new Map<string, Entry>();
    const assistSessionFor = (conversationId: string): Session => {
      const now = Date.now();
      for (const [key, entry] of assistSessions) {
        if (now - entry.lastTouch >= ASSIST_SESSION_IDLE_MS) {
          assistSessions.delete(key);
        }
      }
      let entry = assistSessions.get(conversationId);
      if (!entry) {
        entry = {
          session: new Session({ idleTimeoutMs: ASSIST_SESSION_IDLE_MS }),
          lastTouch: now,
        };
        assistSessions.set(conversationId, entry);
      } else {
        entry.lastTouch = now;
      }
      return entry.session;
    };
    const port = parseInt(process.env.HTTP_SERVER_PORT ?? '3000', 10);
    tasks.push(
      runners.http({
        agent,
        assistAgent,
        assistSessionFor,
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

  let realtimeServer: RealtimeServer | null = null;
  if (deps.config.realtime.enabled) {
    // Process-wide cache shared across all bridges (each WS connection
    // spawns a fresh RealtimeBridge but they all hit the same HA — there's
    // no per-user state to isolate). Re-created on process restart so a
    // server bounce flushes stale device snapshots.
    const toolCache = new ToolResultCache();
    const TOOL_CACHE_TTL_MS = 5_000;
    realtimeServer = await startRealtimeServer({
      port: deps.config.realtime.port,
      token: deps.config.realtime.token,
      buildBridgeDeps: async () => ({
        apiKey: deps.config.openai.apiKey,
        model: deps.config.realtime.model,
        voice: deps.config.realtime.voice,
        reasoningEffort: deps.config.realtime.reasoningEffort,
        instructions: buildSystemPromptFor('realtime'),
        tools: [
          ...mcpToolsToRealtime(await deps.mcp.listTools()),
          ((): RealtimeTool => {
            const t = buildWeatherTool();
            return {
              type: 'function',
              name: t.name,
              description: t.description,
              parameters: t.parameters,
            };
          })(),
        ],
        runTool: async (name, args) => {
          const safeArgs: Record<string, unknown> = {};
          if (args && typeof args === 'object') {
            Object.assign(safeArgs, args);
          }
          if (name === WEATHER_TOOL_NAME) {
            try {
              return JSON.stringify(await executeWeatherTool(safeArgs));
            } catch (e) {
              return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
            }
          }
          if (CACHEABLE_TOOLS.has(name)) {
            const key = `${name}:${JSON.stringify(safeArgs)}`;
            const cached = toolCache.get(key);
            if (cached !== undefined) {
              log.info({ name }, `${name} cache hit`);
              return cached;
            }
            const result = await deps.mcp.callTool(name, safeArgs);
            const serialized = JSON.stringify(result);
            toolCache.set(key, serialized, TOOL_CACHE_TTL_MS);
            return serialized;
          }
          // Any non-cacheable tool may have mutated state (HassTurnOn /
          // HassTurnOff / SetClimate / ...). Drop the snapshot so the
          // next GetLiveContext goes to HA for real.
          toolCache.clear(name);
          const result = await deps.mcp.callTool(name, safeArgs);
          return JSON.stringify(result);
        },
      }),
    });
    log.info({ port: realtimeServer.port }, 'realtime server listening');
  }

  const onShutdown = async (signal: string): Promise<void> => {
    log.info({ signal }, `received ${signal}, shutting down`);
    if (realtimeServer) {
      await realtimeServer.close().catch(() => {});
    }
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
    if (realtimeServer) {
      await realtimeServer.close().catch(() => {});
    }
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
