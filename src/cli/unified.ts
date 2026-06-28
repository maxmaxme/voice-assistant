import 'dotenv/config';

import { initializeCommonDependencies, buildSystemPromptFor, type CommonDeps } from './shared.ts';
import { runTelegramMode, perChatSender, type TelegramRunnerDeps } from './runners/telegram.ts';
import { runHttpMode, type HttpRunnerDeps } from './runners/http.ts';
import { startRealtimeServer, type RealtimeServer } from '../realtime/index.ts';
import { mcpToolsToRealtime, localToolsToRealtime } from '../realtime/toolAdapter.ts';
import { applyHaToolSuffixes } from '../agent/toolBridge.ts';
import { buildLocalToolset } from '../agent/localTools.ts';
import { makeScopedProfile } from '../memory/scope.ts';
import { hashToken } from '../memory/identities.ts';
import type { IdentitiesAdapter } from '../memory/types.ts';
import { appendUserContext } from '../agent/systemPrompt.ts';
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

/** Authenticate a Voice PE device by its bearer token: hash → `voice` identity.
 *  Returns the owning principal, or null when the token is not a registered
 *  device (the WS handshake then rejects it — there is no household fallback).
 *  Stamps `last_used_at` on success. */
export function authorizeSpeaker(
  identities: IdentitiesAdapter,
  token: string,
): { userId: number } | null {
  const hash = hashToken(token);
  const res = identities.resolve('voice', hash);
  if (!res) {
    return null;
  }
  identities.touch('voice', hash);
  return { userId: res.userId };
}

/** Dispatch logic, exported for tests. Does NOT call initializeCommonDependencies
 * — the caller passes deps so tests can use mocks. */
export async function dispatch(deps: CommonDeps, runners: RunnerSet): Promise<void> {
  const tasks: Promise<void>[] = [];

  // Each channel self-gates: Telegram on its integration, HTTP on its enable
  // toggle (both DB-backed, web panel). There is no AGENT_MODE any more.
  const telegram = deps.telegram;
  if (telegram) {
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
        agent,
        sessionFor,
        memory: deps.memory,
        identities: deps.memory.identities,
        profileStore: deps.memory.profileStore,
        replyTo: perChatSender(telegram.botToken),
        voiceTranscriber: new BotVoiceTranscriber({
          botToken: telegram.botToken,
          stt: new OpenAiStt({ client: deps.llm }),
        }),
        photoLoader: new BotPhotoLoader({
          botToken: telegram.botToken,
        }),
      }),
    );
  }

  if (deps.http.enabled) {
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
    const port = deps.config.http.port;
    tasks.push(
      runners.http({
        agent,
        assistAgent,
        assistSessionFor,
        stt: new OpenAiStt({ client: deps.llm }),
        port,
        identities: deps.memory.identities,
        profileStore: deps.memory.profileStore,
      }),
    );
  }

  if (tasks.length === 0) {
    // Not fatal: the scheduler (below) and the realtime server (started in
    // main(), gated separately) may still be the active surface. Promise.race
    // over no tasks never settles, so the process stays alive for them.
    log.warn('no Telegram or HTTP channel enabled — only the scheduler / realtime will run');
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
  // Init first: it layers DB-backed settings over process.env, so TZ below
  // reflects web-edited values. web_search comes from the resolved OpenAI
  // integration; each channel self-gates (telegram/http/realtime toggles).
  const deps = await initializeCommonDependencies();

  const channels = {
    telegram: deps.telegram !== null,
    http: deps.http.enabled,
    realtime: deps.realtime.enabled,
  };
  const webSearchOn = deps.openai.webSearch;
  log.info(
    { channels, tz: getServerTimezone(), webSearch: webSearchOn },
    `channels: telegram=${channels.telegram} http=${channels.http} realtime=${channels.realtime} TZ=${getServerTimezone()}${webSearchOn ? ' WEB_SEARCH=on' : ''}`,
  );

  let realtimeServer: RealtimeServer | null = null;
  // Realtime is opt-in via the DB-backed enable switch (web panel's Realtime
  // page). Devices authenticate per-connection against the registered `voice`
  // identities — no shared env token. Port stays env (infra).
  if (deps.realtime.enabled) {
    // Process-wide cache shared across all bridges (each WS connection
    // spawns a fresh RealtimeBridge but they all hit the same HA — there's
    // no per-user state to isolate). Re-created on process restart so a
    // server bounce flushes stale device snapshots.
    const toolCache = new ToolResultCache();
    const TOOL_CACHE_TTL_MS = 5_000;
    realtimeServer = await startRealtimeServer({
      port: deps.config.realtime.port,
      authorize: (token) => authorizeSpeaker(deps.memory.identities, token),
      buildBridgeDeps: async (auth) => {
        // The handshake already resolved the device to its owning principal, so
        // the speaker reads household ∪ its own personal memory, and
        // scheduled-action tools are owner-aware. A speaker has no Telegram, so
        // scheduling from it is refused by the tool — correct until speaker-side
        // delivery exists.
        const profile = makeScopedProfile(deps.memory.profileStore, { userId: auth.userId });
        const localToolset = buildLocalToolset({
          profile,
          scheduledActions: deps.memory.scheduledActions,
          identities: deps.memory.identities,
          ownerUserId: auth.userId,
          telegram: { senderFor: deps.senderFor },
        });
        return {
          apiKey: deps.openai.apiKey,
          model: deps.openai.realtime.model,
          voice: deps.openai.realtime.voice,
          reasoningEffort: deps.openai.realtime.reasoningEffort,
          idleResetMs: deps.realtime.idleResetMs,
          outputPacingMs: deps.realtime.outputPacingMs,
          instructions: appendUserContext(
            buildSystemPromptFor('realtime', deps.haEnabled),
            profile.recall(),
          ),
          tools: [
            ...mcpToolsToRealtime(applyHaToolSuffixes(await deps.mcp.listTools())),
            ...localToolsToRealtime(localToolset.tools),
          ],
          runTool: async (name, args) => {
            const safeArgs: Record<string, unknown> = {};
            if (args && typeof args === 'object') {
              Object.assign(safeArgs, args);
            }
            if (localToolset.names.has(name)) {
              try {
                return JSON.stringify(await localToolset.execute(name, safeArgs));
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
        };
      },
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
    await dispatch(deps, {
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
