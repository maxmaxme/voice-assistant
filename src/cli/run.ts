import OpenAI from 'openai';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadConfig } from '../config.ts';
import { HaMcpClient } from '../mcp/haMcpClient.ts';
import { OpenAiAgent } from '../agent/openaiAgent.ts';
import { ConversationStore } from '../agent/conversationStore.ts';
import { SqliteProfileMemory } from '../memory/sqliteProfileMemory.ts';
import { NodeSpeakerOutput } from '../audio/speakerOutput.ts';
import { OpenAiStt } from '../audio/openaiStt.ts';
import { OpenAiTts } from '../audio/openaiTts.ts';
import { OpenWakeWord } from '../audio/wakeWord.ts';
import { Orchestrator } from '../orchestrator/orchestrator.ts';
import { BASE_SYSTEM_PROMPT } from '../agent/systemPrompt.ts';

const SYSTEM_PROMPT = `${BASE_SYSTEM_PROMPT}

Voice channel specifics: keep replies under 1 sentence when possible. Avoid
markdown, lists, code, or punctuation that doesn't read well out loud.

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

async function main(): Promise<void> {
  const cfg = loadConfig();
  fs.mkdirSync(path.dirname(cfg.memory.dbPath), { recursive: true });

  const llm = new OpenAI({ apiKey: cfg.openai.apiKey });
  const mcp = new HaMcpClient({ url: cfg.ha.url, token: cfg.ha.token });
  const memory = new SqliteProfileMemory({ dbPath: cfg.memory.dbPath });
  await mcp.connect();

  const agent = new OpenAiAgent({
    mcp,
    memory,
    store: new ConversationStore({ idleTimeoutMs: 3 * 60 * 1000, maxMessages: 20 }),
    systemPrompt: SYSTEM_PROMPT,
    model: cfg.openai.model,
    llmClient: llm,
  });

  const wake = new OpenWakeWord({
    pythonPath: cfg.wakeWord.pythonPath,
    scriptPath: cfg.wakeWord.scriptPath,
    keyword: cfg.wakeWord.keyword,
    threshold: cfg.wakeWord.threshold,
    debug: cfg.wakeWord.debug,
  });

  const orch = new Orchestrator({
    agent,
    stt: new OpenAiStt({ client: llm }),
    tts: new OpenAiTts({ client: llm }),
    speaker: new NodeSpeakerOutput(),
    wake,
    sampleRate: wake.sampleRate,
    followUp: cfg.wakeWord.followUp,
  });

  process.on('SIGINT', async () => {
    await wake.stop();
    await mcp.disconnect();
    memory.close();
    process.exit(0);
  });

  await orch.run();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
