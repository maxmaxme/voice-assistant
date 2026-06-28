import * as fs from 'node:fs';
import * as path from 'node:path';
import OpenAI from 'openai';
import { loadConfig, type Config } from '../config.ts';
import { HaMcpClient } from '../mcp/haMcpClient.ts';
import { OpenAiAgent } from '../agent/openaiAgent.ts';
import { Session } from '../agent/session.ts';
import { openMemoryStore } from '../memory/memoryStore.ts';
import type { MemoryStore } from '../memory/types.ts';
import { initPromptRegistry, resolvePrompt } from '../agent/prompts/registry.ts';
import { buildEnvOverlay } from '../settings/settable.ts';
import { receiverFromConfig } from '../telegram/fromConfig.ts';
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

export const AGENT_MODES = ['telegram', 'http', 'both'] as const;
export type AgentMode = (typeof AGENT_MODES)[number];

/** "Channel" = a system-prompt flavour. Multiple modes can share a channel.
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

export function buildSystemPromptFor(channel: PromptChannel): string {
  const parts: string[] = [resolvePrompt('base-system')];
  if (channel === 'assist') {
    parts.push(resolvePrompt('voice-addendum'));
    return parts.join('\n\n');
  }
  if (channel === 'realtime') {
    // Realtime emits audio directly — the text-channel voice rules in
    // `voice-addendum.md` would just confuse the model. Use a lean,
    // audio-only addendum and stop here.
    parts.push(resolvePrompt('realtime-addendum'));
    return parts.join('\n\n');
  }
  return parts.join('\n\n');
}

function isAgentMode(value: string): value is AgentMode {
  const set: ReadonlySet<string> = new Set<string>(AGENT_MODES);
  return set.has(value);
}

export function parseAgentMode(raw: string | undefined): AgentMode {
  if (!raw) {
    return 'both';
  }
  if (isAgentMode(raw)) {
    return raw;
  }
  throw new Error(`AGENT_MODE=${raw}: expected one of ${AGENT_MODES.join(', ')}`);
}

export interface CommonDeps {
  config: Config;
  llm: OpenAI;
  mcp: HaMcpClient;
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
}

/** Initialise everything shared across runners. Call once per process. */
export async function initializeCommonDependencies(): Promise<CommonDeps> {
  // Two-phase config load: read env first to learn the DB path (not a
  // web-settable key), open the store, then re-load with the DB-backed
  // overrides layered over env. Changes apply on the next start by design.
  const envConfig = loadConfig();
  fs.mkdirSync(path.dirname(envConfig.memory.dbPath), { recursive: true });
  const memory = openMemoryStore(envConfig.memory.dbPath);
  // Layer the DB-backed overrides over the real env. We also mutate process.env
  // itself so the handful of consumers that read it directly — TZ,
  // AGENT_MODE, OPENAI_WEB_SEARCH — honour the web-edited values, not just the
  // typed `config` object.
  const overlay = buildEnvOverlay(memory.settings);
  Object.assign(process.env, overlay);
  const config = loadConfig({ ...process.env, ...overlay });

  // Seed every bundled prompt into the DB (skipping ones already edited) and
  // route all prompt reads through the DB for the rest of the process.
  initPromptRegistry(memory.prompts);

  const llm = new OpenAI({ apiKey: config.openai.apiKey });
  const mcp = new HaMcpClient({ url: config.ha.url, token: config.ha.token });
  const senderFor = (chatId: string): TelegramSender =>
    new BotTelegramSender({ botToken: config.telegram.botToken, chatId });

  await connectMcpWithRetry(mcp);

  // Goal-mode agent: dedicated session, base system prompt (no channel suffix);
  // goal mode produces a written summary, never speaks.
  const goalAgent = new OpenAiAgent({
    mode: 'goal',
    mcp,
    memory,
    session: new Session(),
    systemPrompt: resolvePrompt('base-system'),
    model: config.openai.model,
    reasoningEffort: config.openai.reasoningEffort,
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
      systemPrompt: buildSystemPromptFor(channel),
      model: config.openai.model,
      reasoningEffort: config.openai.reasoningEffort,
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
    activeReceiver = receiverFromConfig(config);
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
  };
}
