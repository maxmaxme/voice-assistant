import * as fs from 'node:fs';
import * as path from 'node:path';
import OpenAI from 'openai';
import { loadConfig, type Config } from '../config.ts';
import { HaMcpClient } from '../mcp/haMcpClient.ts';
import { OpenAiAgent } from '../agent/openaiAgent.ts';
import { Session } from '../agent/session.ts';
import { openMemoryStore } from '../memory/memoryStore.ts';
import type { MemoryStore } from '../memory/types.ts';
import { loadPrompt } from '../agent/prompts/load.ts';
import { BASE_SYSTEM_PROMPT } from '../agent/systemPrompt.ts';
import { telegramFromConfig, receiverFromConfig } from '../telegram/fromConfig.ts';
import type { TelegramSender, TelegramReceiver } from '../telegram/types.ts';
import { CHAT_TEXT_FORMAT } from '../agent/agentOutput.ts';
import { buildGoalRunner, type GoalRunner } from '../scheduling/goalRunner.ts';

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
 *                    spoken DIRECTLY by the Realtime model — no JSON parsing
 *                    layer, so the text-format addendum (which mandates
 *                    `{"speak": ..., "direction": ...}`) must NOT apply,
 *                    otherwise the model proudly pronounces the JSON keys.
 *                    Same voice rules as `assist`.
 */
export type PromptChannel = 'telegram' | 'http' | 'assist' | 'realtime';

const TEXT_FORMAT_ADDENDUM = loadPrompt('./prompts/text-format-addendum.md', import.meta.url);
const VOICE_ADDENDUM = loadPrompt('./prompts/voice-addendum.md', import.meta.url);
const REALTIME_ADDENDUM = loadPrompt('./prompts/realtime-addendum.md', import.meta.url);

export function buildSystemPromptFor(channel: PromptChannel): string {
  const parts: string[] = [BASE_SYSTEM_PROMPT];
  if (channel === 'assist') {
    parts.push(VOICE_ADDENDUM);
    parts.push(TEXT_FORMAT_ADDENDUM);
    return parts.join('\n\n');
  }
  if (channel === 'realtime') {
    // Realtime emits audio directly — no JSON `speak` field, so the
    // text-format addendum and the JSON-flavoured voice rules in
    // `voice-addendum.md` would just confuse the model. Use a lean,
    // audio-only addendum and stop here.
    parts.push(REALTIME_ADDENDUM);
    return parts.join('\n\n');
  }
  parts.push(TEXT_FORMAT_ADDENDUM);
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
  telegram: TelegramSender;
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
  const config = loadConfig();
  fs.mkdirSync(path.dirname(config.memory.dbPath), { recursive: true });

  const llm = new OpenAI({ apiKey: config.openai.apiKey });
  const mcp = new HaMcpClient({ url: config.ha.url, token: config.ha.token });
  const memory = openMemoryStore(config.memory.dbPath);
  const telegram = telegramFromConfig(config);

  await mcp.connect();

  // Goal-mode agent: dedicated session, base system prompt (no channel suffix),
  // chat text format (goal mode produces a written summary, never speaks).
  const goalAgent = new OpenAiAgent({
    mode: 'goal',
    mcp,
    memory,
    session: new Session(),
    systemPrompt: BASE_SYSTEM_PROMPT,
    model: config.openai.model,
    reasoningEffort: config.openai.reasoningEffort,
    llmClient: llm,
    telegram,
    textFormat: CHAT_TEXT_FORMAT,
  });
  const goalRunner: GoalRunner = buildGoalRunner({ agent: goalAgent, telegram });

  const buildAgent = (channel: PromptChannel): OpenAiAgent =>
    new OpenAiAgent({
      mcp,
      memory,
      session: new Session(),
      systemPrompt: buildSystemPromptFor(channel),
      model: config.openai.model,
      reasoningEffort: config.openai.reasoningEffort,
      llmClient: llm,
      telegram,
      textFormat: CHAT_TEXT_FORMAT,
      // `ask` is only worth exposing where a positive expectsFollowUp
      // actually reopens the mic for the user. The `assist` channel sits
      // behind HA bridge / Voice PE which reads continue_conversation from
      // the /assist response. Plain HTTP `/text` and `/audio` are
      // Apple-Shortcut-style one-shot calls — no follow-up plumbing — and
      // Telegram just lets the model ask inside `speak`.
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

  return { config, llm, mcp, memory, telegram, buildAgent, dispose, telegramReceiver, goalRunner };
}
