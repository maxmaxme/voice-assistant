import OpenAI from 'openai';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadConfig } from '../config.js';
import { HaMcpClient } from '../mcp/haMcpClient.js';
import { OpenAiAgent } from '../agent/openaiAgent.js';
import { ConversationStore } from '../agent/conversationStore.js';
import { SqliteProfileMemory } from '../memory/sqliteProfileMemory.js';
import { NodeSpeakerOutput } from '../audio/speakerOutput.js';
import { OpenAiStt } from '../audio/openaiStt.js';
import { OpenAiTts } from '../audio/openaiTts.js';
import { OpenWakeWord } from '../audio/wakeWord.js';
import { Orchestrator } from '../orchestrator/orchestrator.js';
import { BASE_SYSTEM_PROMPT } from '../agent/systemPrompt.js';

const SYSTEM_PROMPT = `${BASE_SYSTEM_PROMPT}

Voice channel specifics: keep replies under 1 sentence when possible. Avoid
markdown, lists, code, or punctuation that doesn't read well out loud.`;

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
  });

  const orch = new Orchestrator({
    agent,
    stt: new OpenAiStt({ client: llm }),
    tts: new OpenAiTts({ client: llm }),
    speaker: new NodeSpeakerOutput(),
    wake,
    sampleRate: wake.sampleRate,
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
