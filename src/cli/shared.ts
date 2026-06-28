import * as fs from 'node:fs';
import * as path from 'node:path';
import OpenAI from 'openai';
import { loadConfig, type Config } from '../config.ts';
import { HaMcpClient } from '../mcp/haMcpClient.ts';
import { NullMcpClient } from '../mcp/nullMcpClient.ts';
import type { McpClient } from '../mcp/types.ts';
import { resolveHaConfig } from '../integrations/homeAssistant.ts';
import { resolveOpenAiConfig, type OpenAiConfig } from '../integrations/openai.ts';
import { resolveTelegramConfig, type TelegramConfig } from '../integrations/telegram.ts';
import { resolveRealtimeConfig, type RealtimeConfig } from '../settings/realtimeConfig.ts';
import { resolveHttpConfig, type HttpConfig } from '../settings/httpConfig.ts';
import { resolveTelegramEnabled } from '../settings/telegramRuntime.ts';
import { OpenAiAgent } from '../agent/openaiAgent.ts';
import { Session } from '../agent/session.ts';
import { openMemoryStore } from '../memory/memoryStore.ts';
import type { MemoryStore } from '../memory/types.ts';
import { initPromptRegistry, resolvePrompt } from '../agent/prompts/registry.ts';
import { receiverFromToken } from '../telegram/fromConfig.ts';
import { BotTelegramSender } from '../telegram/telegramSender.ts';
import type { TelegramSender, TelegramReceiver } from '../telegram/types.ts';
import { buildGoalRunner, type GoalRunner } from '../scheduling/goalRunner.ts';
import { createLogger } from '../utils/logger.ts';

const log = createLogger('shared');

async function connectMcpWithRetry(mcp: HaMcpClient): Promise<void> {
  const maxAttempts = 20;
  const delayMs = 3000;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await mcp.connect();
      if (attempt > 1) {
        log.info({ attempt }, 'mcp connected after retries');
      }
      return;
    } catch (err) {
      lastErr = err;
      log.warn(
        { attempt, maxAttempts, err: err instanceof Error ? err.message : String(err) },
        'mcp connect failed, retrying',
      );
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastErr;
}

/** "Channel" = a system-prompt flavour. Multiple channels can share a flavour.
 *
 *  - `telegram`    — Telegram bot. Plain text. `ask` off.
 *  - `http`        — HTTP `/text` and `/audio` (Apple Shortcut etc). Plain
 *                    text. `ask` off.
 *  - `assist`      — HTTP `/assist` (HA bridge → Voice PE TTS). Output is
 *                    spoken aloud by Home Assistant, so the voice-addendum
 *                    rules apply (spell out units, no markdown/URLs/etc).
 *                    `ask` on — `expectsFollowUp` is forwarded as
 *                    `continue_conversation` so HA reopens the mic.
 *  - `realtime`    — Direct WS to Voice PE via OpenAI Realtime. Output is
 *                    spoken DIRECTLY by the Realtime model; uses a lean
 *                    audio-only addendum instead of the text-channel voice
 *                    rules.
 */
export type PromptChannel = 'telegram' | 'http' | 'assist' | 'realtime';

/** base-system, plus the HA device-control rules only when HA is configured.
 *  Without HA the agent is a general chat assistant (memory, weather, reminders)
 *  and must NOT be told to drive non-existent device tools. */
function basePromptParts(haEnabled: boolean): string[] {
  const parts = [resolvePrompt('base-system')];
  if (haEnabled) {
    parts.push(resolvePrompt('ha-addendum'));
  }
  return parts;
}

export function buildSystemPromptFor(channel: PromptChannel, haEnabled = true): string {
  const parts = basePromptParts(haEnabled);
  if (channel === 'assist') {
    parts.push(resolvePrompt('voice-addendum'));
  } else if (channel === 'realtime') {
    // Realtime emits audio directly — the text-channel voice rules in
    // `voice-addendum.md` would just confuse the model. Use a lean,
    // audio-only addendum.
    parts.push(resolvePrompt('realtime-addendum'));
  }
  return parts.join('\n\n');
}

export interface CommonDeps {
  config: Config;
  llm: OpenAI;
  mcp: McpClient;
  memory: MemoryStore;
  /** Build a Telegram sender bound to a chat id. The single outbound primitive
   * now that there is no fixed default chat — `send_to_telegram` and the goal
   * runner resolve a recipient's chat via identities and build a sender here. */
  senderFor: (chatId: string) => TelegramSender;
  /** Build a fresh agent for a given channel. Each channel gets its own
   * Session so they don't trample each other's `previous_response_id` chain. */
  buildAgent(channel: PromptChannel): OpenAiAgent;
  dispose(): Promise<void>;
  /** Create a TelegramReceiver backed by the configured bot. Tracks the active
   * receiver so dispose() can stop it on shutdown. */
  telegramReceiver(): TelegramReceiver;
  goalRunner: GoalRunner;
  /** Whether the Home Assistant integration is configured — gates HA-specific
   *  system-prompt rules on the realtime path. */
  haEnabled: boolean;
  /** Resolved OpenAI integration config (api key, models, realtime model/voice/
   *  effort). The realtime *enable* switch is `realtime.enabled`, not here. */
  openai: OpenAiConfig;
  /** Resolved Telegram integration config (bot token), or null when not
   *  installed/enabled. Credentials only — running the bot also needs
   *  `telegramEnabled`. */
  telegram: TelegramConfig | null;
  /** The Telegram channel's own enable toggle (web panel's Telegram page),
   *  separate from the integration: the bot runs only when this is on AND a
   *  token is configured. */
  telegramEnabled: boolean;
  /** Realtime (Voice PE) config from the DB (enable + pacing + idle). The
   *  realtime server starts only when `realtime.enabled` (and a device token). */
  realtime: RealtimeConfig;
  /** HTTP server config from the DB (enable). The `/text` `/audio` `/assist`
   *  server starts only when `http.enabled`. */
  http: HttpConfig;
}

/** Initialise everything shared across runners. Call once per process. */
export async function initializeCommonDependencies(): Promise<CommonDeps> {
  // All config is env (process-level: db path, TZ, ports) or DB-backed feature
  // config read by dedicated resolvers below (integrations, realtime, http).
  // There is no env-overlay any more — nothing is web-edited *into* env.
  const config = loadConfig();
  fs.mkdirSync(path.dirname(config.memory.dbPath), { recursive: true });
  const memory = openMemoryStore(config.memory.dbPath);

  // Seed every bundled prompt into the DB (skipping ones already edited) and
  // route all prompt reads through the DB for the rest of the process.
  initPromptRegistry(memory.prompts);

  // Realtime + HTTP enable/config are DB-only, read like an integration — never
  // from env. Device token + ports come from `config`.
  const realtime = resolveRealtimeConfig(memory.settings);
  const http = resolveHttpConfig(memory.settings);
  const telegramEnabled = resolveTelegramEnabled(memory.settings);

  // OpenAI comes from the web-configured integration, not env. It's mandatory —
  // fail fast with a clear message if it's not installed/enabled.
  const openai = resolveOpenAiConfig(memory.integrations);
  if (!openai) {
    throw new Error(
      'OpenAI integration is not configured. Install & enable it in the web panel (Integrations → OpenAI).',
    );
  }
  const llm = new OpenAI({ apiKey: openai.apiKey, baseURL: openai.baseUrl });

  // Telegram comes from the web-configured integration (token), not env, and
  // the channel runs only when its own toggle is on. senderFor still exists
  // unconditionally (the goal runner and send_to_telegram call it) but throws
  // when Telegram isn't active, so the failure is visible instead of dropped.
  const telegram = resolveTelegramConfig(memory.integrations);
  const telegramActive = telegram !== null && telegramEnabled;
  const senderFor = (chatId: string): TelegramSender =>
    telegram && telegramActive
      ? new BotTelegramSender({ botToken: telegram.botToken, chatId })
      : {
          send: async (): Promise<void> => {
            throw new Error('Telegram is not enabled.');
          },
        };

  // Home Assistant comes from the web-configured integration, not env. No
  // integration → a null MCP client (zero tools), so the agent runs without HA.
  const ha = resolveHaConfig(memory.integrations);
  const haEnabled = ha !== null;
  let mcp: McpClient;
  if (ha) {
    const haClient = new HaMcpClient({ url: ha.url, token: ha.token });
    await connectMcpWithRetry(haClient);
    mcp = haClient;
  } else {
    log.warn('home-assistant integration not configured — HA MCP tools disabled');
    mcp = new NullMcpClient();
  }

  // Goal-mode agent: dedicated session, base system prompt (no channel suffix);
  // goal mode produces a written summary, never speaks.
  const goalAgent = new OpenAiAgent({
    mode: 'goal',
    mcp,
    memory,
    session: new Session(),
    systemPrompt: basePromptParts(haEnabled).join('\n\n'),
    model: openai.model,
    reasoningEffort: openai.reasoningEffort,
    webSearch: openai.webSearch,
    llmClient: llm,
    telegram: { senderFor },
  });
  const goalRunner: GoalRunner = buildGoalRunner({
    agent: goalAgent,
    identities: memory.identities,
    senderFor,
  });

  const buildAgent = (channel: PromptChannel): OpenAiAgent =>
    new OpenAiAgent({
      mcp,
      memory,
      session: new Session(),
      systemPrompt: buildSystemPromptFor(channel, haEnabled),
      model: openai.model,
      reasoningEffort: openai.reasoningEffort,
      webSearch: openai.webSearch,
      llmClient: llm,
      telegram: { senderFor },
      // `ask` is only worth exposing where a positive expectsFollowUp
      // actually reopens the mic for the user. The `assist` channel sits
      // behind HA bridge / Voice PE which reads continue_conversation from
      // the /assist response. Plain HTTP `/text` and `/audio` are
      // Apple-Shortcut-style one-shot calls — no follow-up plumbing — and
      // Telegram just lets the model ask in its reply text.
      enableAsk: channel === 'assist',
    });

  let activeReceiver: TelegramReceiver | null = null;
  const telegramReceiver = (): TelegramReceiver => {
    if (!telegram || !telegramActive) {
      throw new Error('Telegram is not enabled.');
    }
    activeReceiver = receiverFromToken(telegram.botToken);
    return activeReceiver;
  };

  let disposed = false;
  const dispose = async (): Promise<void> => {
    if (disposed) {
      return;
    }
    disposed = true;
    if (activeReceiver) {
      await activeReceiver.stop().catch(() => {});
    }
    await mcp.disconnect();
    memory.close();
  };

  return {
    config,
    llm,
    mcp,
    memory,
    senderFor,
    buildAgent,
    dispose,
    telegramReceiver,
    goalRunner,
    haEnabled,
    openai,
    telegram,
    telegramEnabled,
    realtime,
    http,
  };
}
