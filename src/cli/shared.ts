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
import { buildGoalRunner, type GoalRunner } from '../scheduling/goalRunner.ts';

export const AGENT_MODES = ['chat', 'voice', 'wake', 'telegram', 'http', 'both'] as const;
export type AgentMode = (typeof AGENT_MODES)[number];

/** "Channel" = a system-prompt flavour. Multiple modes can share a channel. */
export type PromptChannel = 'chat' | 'voice' | 'wake' | 'telegram' | 'http';

const VOICE_ADDENDUM = `

Voice channel specifics: keep replies under 1 sentence when possible. Avoid
markdown, lists, code, or punctuation that doesn't read well out loud. Never
include URLs, links, or web addresses in the reply — they don't read well out
loud. If a source needs to be shared, send it via send_to_telegram instead.`;

const SILENT_CONFIRM_ADDENDUM = `

SILENT-CONFIRMATION — MANDATORY RULE FOR THIS VOICE CHANNEL:

After any successful device action (lights, switches, scenes, climate, covers),
set speak to null and choose direction based on the action. Never add words.

  speak: null, direction: "on"      → turned ON, raised, opened, activated
  speak: null, direction: "off"     → turned OFF, lowered, closed, deactivated
  speak: null, direction: "neutral" → scene applied, value set, unclear direction

Examples (all use speak: null):
  "turn on the lights"    → HassTurnOn  → {"speak":null,"direction":"on"}
  "turn on all lamps"     → HassTurnOn  → {"speak":null,"direction":"on"}   (even 3 lamps)
  "turn off everything"   → HassTurnOff → {"speak":null,"direction":"off"}  (even many)
  "dim the lights"        → HassSet     → {"speak":null,"direction":"off"}
  "raise the volume"      → HassSet     → {"speak":null,"direction":"on"}
  "activate movie scene"  → activate    → {"speak":null,"direction":"neutral"}
  "open the blinds"       → HassOpen    → {"speak":null,"direction":"on"}

Use speak with real text ONLY when: tool returned an error, or user asked a question.`;

export function buildSystemPromptFor(channel: PromptChannel): string {
  switch (channel) {
    case 'chat':
    case 'telegram':
    case 'http':
      return BASE_SYSTEM_PROMPT;
    case 'voice':
      return `${BASE_SYSTEM_PROMPT}${VOICE_ADDENDUM}`;
    case 'wake':
      return `${BASE_SYSTEM_PROMPT}${VOICE_ADDENDUM}${SILENT_CONFIRM_ADDENDUM}`;
  }
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
    llmClient: llm,
    telegram,
    textFormat: CHAT_TEXT_FORMAT,
  });
  const goalRunner: GoalRunner = buildGoalRunner({ agent: goalAgent });

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
        channel === 'chat' || channel === 'telegram' || channel === 'http'
          ? CHAT_TEXT_FORMAT
          : VOICE_TEXT_FORMAT,
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
