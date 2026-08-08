import 'dotenv/config';

import { initializeCommonDependencies, buildSystemPromptFor, type CommonDeps } from './shared.ts';
import { runTelegramMode, perChatSender, type TelegramRunnerDeps } from './runners/telegram.ts';
import { runHttpMode, type HttpRunnerDeps } from './runners/http.ts';
import { startRealtimeServer, type RealtimeServer } from '../realtime/index.ts';
import { mcpToolsToRealtime, localToolsToRealtime } from '../realtime/toolAdapter.ts';
import { prepareHaTools } from '../agent/toolBridge.ts';
import { buildLocalToolset } from '../agent/localTools.ts';
import { makeScopedProfile } from '../memory/scope.ts';
import { hashToken } from '../memory/identities.ts';
import type { IdentitiesAdapter } from '../memory/types.ts';
import { appendLanguage, appendUserContext } from '../agent/systemPrompt.ts';
import { ToolResultCache } from '../realtime/toolCache.ts';
import { buildRealtimeToolRunner } from '../realtime/toolRunner.ts';
import { Session } from '../agent/session.ts';
import { OpenAiStt } from '../audio/openaiStt.ts';
import { BotVoiceTranscriber } from '../telegram/voiceTranscriber.ts';
import { BotPhotoLoader } from '../telegram/photoLoader.ts';
import { Scheduler } from '../scheduling/scheduler.ts';
import { resolveRealtimeConfig, realtimeDeviceConfig } from '../settings/realtimeConfig.ts';
import { getServerTimezone } from '../utils/time.ts';
import { raceWithTimeout } from '../utils/withTimeout.ts';
import { memoWithTtl } from '../utils/ttlMemo.ts';
import { createLogger } from '../utils/logger.ts';

const log = createLogger('unified');

export interface RunnerSet {
  telegram: (deps: TelegramRunnerDeps) => Promise<void>;
  http: (deps: HttpRunnerDeps) => Promise<void>;
}

export interface DispatchHooks {
  /** Forwarded as the http runner's `onListen` — main() stores the closer so
   *  shutdown can stop the listener before exiting. */
  onHttpListen?: (close: () => Promise<void>) => void;
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
export async function dispatch(
  deps: CommonDeps,
  runners: RunnerSet,
  hooks: DispatchHooks = {},
): Promise<void> {
  const tasks: Promise<void>[] = [];

  // Each channel self-gates from DB-backed web-panel config. Telegram needs a
  // token (integration) AND its enable toggle; HTTP always serves /health but
  // mounts /text /audio /assist per-flag; there is no AGENT_MODE.
  const telegram = deps.telegram;
  if (telegram && deps.telegramEnabled) {
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

  {
    // The HTTP server always runs so /health is always reachable (container
    // healthcheck). /text /audio /assist are mounted per-flag inside the runner.
    const agent = deps.buildAgent('http');
    const assistAgent = deps.buildAgent('assist');
    // Per-conversation Sessions shared by `/assist` and `/text`; the caller
    // owns the key and picks the idle window, so the two endpoints can't
    // collide and each keeps its own notion of "stale". In-memory only: both
    // windows are far shorter than any restart cadence, so SQLite persistence
    // would buy nothing.
    type Entry = { session: Session; lastTouch: number; idleMs: number };
    const sessions = new Map<string, Entry>();
    const sessionFor = (key: string, idleMs: number): Session => {
      const now = Date.now();
      for (const [k, entry] of sessions) {
        if (now - entry.lastTouch >= entry.idleMs) {
          sessions.delete(k);
        }
      }
      let entry = sessions.get(key);
      if (!entry) {
        entry = { session: new Session({ idleTimeoutMs: idleMs }), lastTouch: now, idleMs };
        sessions.set(key, entry);
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
        sessionFor,
        stt: new OpenAiStt({ client: deps.llm }),
        port,
        endpoints: deps.http,
        identities: deps.memory.identities,
        profileStore: deps.memory.profileStore,
        onListen: hooks.onHttpListen,
      }),
    );
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
    telegram: deps.telegram !== null && deps.telegramEnabled,
    http: deps.http,
    realtime: deps.realtime.enabled,
  };
  const httpStr = `text=${deps.http.text} audio=${deps.http.audio} assist=${deps.http.assist}`;
  const webSearchOn = deps.openai.webSearch;
  log.info(
    { channels, tz: getServerTimezone(), webSearch: webSearchOn },
    `channels: telegram=${channels.telegram} http(${httpStr}) realtime=${channels.realtime} TZ=${getServerTimezone()}${webSearchOn ? ' WEB_SEARCH=on' : ''}`,
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
    // The HA tool list barely changes; memoize it so a slow/wedged HA can't
    // delay every speaker handshake with a live listTools round-trip. A fresh
    // process start still fetches fresh (the memo starts empty).
    const TOOL_LIST_TTL_MS = 60_000;
    const listMcpTools = memoWithTtl(() => deps.mcp.listTools(), TOOL_LIST_TTL_MS);
    realtimeServer = await startRealtimeServer({
      port: deps.config.realtime.port,
      authorize: (token) => authorizeSpeaker(deps.memory.identities, token),
      // Device-facing config (the hello payload) is delivered live: poll the DB
      // and push changes to connected devices, so admin edits apply without a
      // restart. Server-side realtime.* config still applies on restart.
      watchDeviceConfig: {
        intervalMs: 15_000,
        read: () => realtimeDeviceConfig(resolveRealtimeConfig(deps.memory.settings)),
      },
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
          enableMemory: deps.tools.memory,
          enableReminders: deps.tools.reminders,
          enableWeather: deps.tools.weather.enabled,
          weatherUnits: deps.tools.weather.units,
          weatherDefaultLocation: deps.tools.weather.defaultLocation,
        });
        return {
          speakerName: deps.memory.identities.userName(auth.userId) ?? undefined,
          apiKey: deps.openai.apiKey,
          model: deps.openai.realtime.model,
          voice: deps.openai.realtime.voice,
          reasoningEffort: deps.openai.realtime.reasoningEffort,
          idleResetMs: deps.realtime.idleResetMs,
          outputPacingMs: deps.realtime.outputPacingMs,
          followUpMs: deps.realtime.followUpMs,
          requestFollowUpMs: deps.realtime.requestFollowUpMs,
          followUpChime: deps.realtime.followUpChime,
          // Read fresh (not the bootstrap value) so a device connecting after an
          // admin change gets the current wake-beep setting in its hello; the
          // watcher above then keeps already-connected devices in sync.
          wakeChime: resolveRealtimeConfig(deps.memory.settings).wakeChime,
          language: deps.realtime.language,
          transcription: deps.realtime.transcription,
          noiseReduction: deps.realtime.noiseReduction,
          instructions: appendLanguage(
            appendUserContext(buildSystemPromptFor('realtime', deps.haEnabled), profile.recall()),
            deps.realtime.language,
          ),
          tools: [
            ...mcpToolsToRealtime(prepareHaTools(await listMcpTools())),
            ...localToolsToRealtime(localToolset.tools),
          ],
          runTool: buildRealtimeToolRunner({
            localToolset,
            mcp: deps.mcp,
            cache: toolCache,
            cacheTtlMs: TOOL_CACHE_TTL_MS,
          }),
        };
      },
    });
    log.info({ port: realtimeServer.port }, 'realtime server listening');
  }

  let closeHttpServer: (() => Promise<void>) | null = null;

  // Bound teardown: a hung grammY stop / MCP disconnect must not leave the
  // container waiting for docker's SIGKILL.
  const SHUTDOWN_TIMEOUT_MS = 5_000;
  const onShutdown = async (signal: string): Promise<void> => {
    log.info({ signal }, `received ${signal}, shutting down`);
    const teardown = (async () => {
      if (realtimeServer) {
        await realtimeServer.close().catch(() => {});
      }
      if (closeHttpServer) {
        await closeHttpServer().catch(() => {});
      }
      await deps.dispose();
    })();
    if ((await raceWithTimeout(teardown, SHUTDOWN_TIMEOUT_MS)) === 'timeout') {
      log.warn(`shutdown did not finish within ${SHUTDOWN_TIMEOUT_MS}ms, exiting anyway`);
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void onShutdown('SIGINT'));
  process.on('SIGTERM', () => void onShutdown('SIGTERM'));

  try {
    await dispatch(
      deps,
      {
        telegram: runTelegramMode,
        http: runHttpMode,
      },
      {
        onHttpListen: (close) => {
          closeHttpServer = close;
        },
      },
    );
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
