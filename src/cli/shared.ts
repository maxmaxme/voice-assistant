import * as fs from 'node:fs';
import * as path from 'node:path';
import OpenAI from 'openai';
import { loadConfig, type Config } from '../config.ts';
import { HaMcpClient } from '../mcp/haMcpClient.ts';
import { OpenAiAgent } from '../agent/openaiAgent.ts';
import { Session } from '../agent/session.ts';
import { SqliteProfileMemory } from '../memory/sqliteProfileMemory.ts';
import { BASE_SYSTEM_PROMPT } from '../agent/systemPrompt.ts';
import { telegramFromConfig, receiverFromConfig } from '../telegram/fromConfig.ts';
import type { TelegramSender, TelegramReceiver } from '../telegram/types.ts';

export const AGENT_MODES = ['chat', 'voice', 'wake', 'telegram', 'both'] as const;
export type AgentMode = (typeof AGENT_MODES)[number];

/** "Channel" = a system-prompt flavour. Multiple modes can share a channel. */
export type PromptChannel = 'chat' | 'voice' | 'wake' | 'telegram';

const VOICE_ADDENDUM = `

Voice channel specifics: keep replies under 1 sentence when possible. Avoid
markdown, lists, code, or punctuation that doesn't read well out loud.`;

const SILENT_CONFIRM_ADDENDUM = `

CRITICAL silent-confirmation rule: when you successfully completed a simple
device action (turning lights/switches/scenes on or off, setting a value)
and have no new information to share, reply with EXACTLY the single
character "✓" and nothing else. Examples:
  user: "включи лампу" → tool call HassTurnOn → reply: "✓"
  user: "выключи свет в кухне" → tool call → reply: "✓"
  user: "включи лампу" → tool returned an error → reply: "Не получилось,
        лампа не отвечает." (real text, NOT ✓)
  user: "какая температура?" → reply: "22 градуса." (real text, NOT ✓)
  user: "что я ел вчера?" → reply: "Я не помню." (real text, NOT ✓)
The user hears a short chime when you reply "✓" — they understand the
action is done. Don't add words like "готово" or "сделано" — just "✓".`;

export function buildSystemPromptFor(channel: PromptChannel): string {
  switch (channel) {
    case 'chat':
    case 'telegram':
      return BASE_SYSTEM_PROMPT;
    case 'voice':
      return `${BASE_SYSTEM_PROMPT}${VOICE_ADDENDUM}`;
    case 'wake':
      return `${BASE_SYSTEM_PROMPT}${VOICE_ADDENDUM}${SILENT_CONFIRM_ADDENDUM}`;
  }
}

export function parseAgentMode(raw: string | undefined): AgentMode {
  if (!raw) return 'both';
  if ((AGENT_MODES as readonly string[]).includes(raw)) return raw as AgentMode;
  throw new Error(`AGENT_MODE=${raw}: expected one of ${AGENT_MODES.join(', ')}`);
}

export interface CommonDeps {
  config: Config;
  llm: OpenAI;
  mcp: HaMcpClient;
  memory: SqliteProfileMemory;
  telegram: TelegramSender;
  /** Build a fresh agent for a given channel. Each channel gets its own
   * Session so they don't trample each other's `previous_response_id` chain. */
  buildAgent(channel: PromptChannel): OpenAiAgent;
  dispose(): Promise<void>;
  /** Create a TelegramReceiver backed by the configured bot. Tracks the active
   * receiver so dispose() can stop it on shutdown. */
  telegramReceiver(): TelegramReceiver;
}

/** Initialise everything shared across runners. Call once per process. */
export async function initializeCommonDependencies(): Promise<CommonDeps> {
  const config = loadConfig();
  fs.mkdirSync(path.dirname(config.memory.dbPath), { recursive: true });

  const llm = new OpenAI({ apiKey: config.openai.apiKey });
  const mcp = new HaMcpClient({ url: config.ha.url, token: config.ha.token });
  const memory = new SqliteProfileMemory({ dbPath: config.memory.dbPath });
  const telegram = telegramFromConfig(config);

  await mcp.connect();

  const buildAgent = (channel: PromptChannel): OpenAiAgent =>
    new OpenAiAgent({
      mcp,
      memory,
      session: new Session(),
      systemPrompt: buildSystemPromptFor(channel),
      model: config.openai.model,
      llmClient: llm,
      telegram,
    });

  let activeReceiver: TelegramReceiver | null = null;
  const telegramReceiver = (): TelegramReceiver => {
    activeReceiver = receiverFromConfig(config);
    return activeReceiver;
  };

  let disposed = false;
  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    if (activeReceiver) await activeReceiver.stop().catch(() => {});
    await mcp.disconnect();
    memory.close();
  };

  return { config, llm, mcp, memory, telegram, buildAgent, dispose, telegramReceiver };
}
