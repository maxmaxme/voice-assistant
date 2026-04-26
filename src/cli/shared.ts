import * as fs from 'node:fs';
import * as path from 'node:path';
import OpenAI from 'openai';
import { loadConfig, type Config } from '../config.ts';
import { HaMcpClient } from '../mcp/haMcpClient.ts';
import { OpenAiAgent } from '../agent/openaiAgent.ts';
import { Session } from '../agent/session.ts';
import { openMemoryStore } from '../memory/memoryStore.ts';
import type { MemoryStore } from '../memory/types.ts';
import { BASE_SYSTEM_PROMPT } from '../agent/systemPrompt.ts';
import { telegramFromConfig, receiverFromConfig } from '../telegram/fromConfig.ts';
import type { TelegramSender, TelegramReceiver } from '../telegram/types.ts';
import { VOICE_TEXT_FORMAT, CHAT_TEXT_FORMAT } from '../agent/agentOutput.ts';
import type { FireSink } from '../scheduling/types.ts';

export const AGENT_MODES = ['chat', 'voice', 'wake', 'telegram', 'http', 'both'] as const;
export type AgentMode = (typeof AGENT_MODES)[number];

/** "Channel" = a system-prompt flavour. Multiple modes can share a channel. */
export type PromptChannel = 'chat' | 'voice' | 'wake' | 'telegram';

const VOICE_ADDENDUM = `

Voice channel specifics: keep replies under 1 sentence when possible. Avoid
markdown, lists, code, or punctuation that doesn't read well out loud.`;

const SILENT_CONFIRM_ADDENDUM = `

SILENT-CONFIRMATION — MANDATORY RULE FOR THIS VOICE CHANNEL:

After any successful device action (lights, switches, scenes, climate, covers),
set speak to null and choose direction based on the action. Never add words.

  speak: null, direction: "on"      → turned ON, raised, opened, activated
  speak: null, direction: "off"     → turned OFF, lowered, closed, deactivated
  speak: null, direction: "neutral" → scene applied, value set, unclear direction

Examples (all use speak: null):
  "включи свет"      → HassTurnOn  → {"speak":null,"direction":"on"}
  "включи все лампы" → HassTurnOn  → {"speak":null,"direction":"on"}   (even 3 lamps)
  "выключи всё"      → HassTurnOff → {"speak":null,"direction":"off"}  (even many)
  "убавь яркость"    → HassSet     → {"speak":null,"direction":"off"}
  "прибавь громкость"→ HassSet     → {"speak":null,"direction":"on"}
  "включи сцену кино"→ activate    → {"speak":null,"direction":"neutral"}
  "открой шторы"     → HassOpen    → {"speak":null,"direction":"on"}

Use speak with real text ONLY when: tool returned an error, or user asked a question.`;

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
  if (!raw) {
    return 'both';
  }
  if ((AGENT_MODES as readonly string[]).includes(raw)) {
    return raw as AgentMode;
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
  fireSink: FireSink;
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

  const fireSink: FireSink = {
    async fire(item) {
      if (item.kind === 'reminder') {
        await telegram.send(`⏰ ${item.text}`);
      } else {
        await telegram.send(`⏱ Timer "${item.label}" finished.`);
      }
    },
  };

  const buildAgent = (channel: PromptChannel): OpenAiAgent =>
    new OpenAiAgent({
      mcp,
      memory,
      session: new Session(),
      systemPrompt: buildSystemPromptFor(channel),
      model: config.openai.model,
      llmClient: llm,
      telegram,
      textFormat:
        channel === 'chat' || channel === 'telegram' ? CHAT_TEXT_FORMAT : VOICE_TEXT_FORMAT,
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

  return { config, llm, mcp, memory, telegram, buildAgent, dispose, telegramReceiver, fireSink };
}
