import OpenAI from 'openai';
import * as readline from 'node:readline/promises';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { stdin as input, stdout as output } from 'node:process';
import { loadConfig } from '../config.ts';
import { HaMcpClient } from '../mcp/haMcpClient.ts';
import { OpenAiAgent } from '../agent/openaiAgent.ts';
import { ConversationStore } from '../agent/conversationStore.ts';
import { SqliteProfileMemory } from '../memory/sqliteProfileMemory.ts';
import { BASE_SYSTEM_PROMPT } from '../agent/systemPrompt.ts';
import { telegramFromConfig } from '../telegram/fromConfig.ts';

const SYSTEM_PROMPT = BASE_SYSTEM_PROMPT;

async function main(): Promise<void> {
  const cfg = loadConfig();
  fs.mkdirSync(path.dirname(cfg.memory.dbPath), { recursive: true });
  const llm = new OpenAI({ apiKey: cfg.openai.apiKey });
  const mcp = new HaMcpClient({ url: cfg.ha.url, token: cfg.ha.token });
  const memory = new SqliteProfileMemory({ dbPath: cfg.memory.dbPath });
  await mcp.connect();
  const store = new ConversationStore({ idleTimeoutMs: 3 * 60 * 1000, maxMessages: 20 });
  const agent = new OpenAiAgent({
    mcp,
    memory,
    store,
    systemPrompt: SYSTEM_PROMPT,
    model: cfg.openai.model,
    llmClient: llm,
    telegram: telegramFromConfig(cfg),
  });

  const rl = readline.createInterface({ input, output });
  console.log('Chat ready. /reset to clear context. /profile to dump profile. Ctrl+C to exit.');

  let closed = false;
  rl.on('close', () => {
    closed = true;
  });

  try {
    while (!closed) {
      let line: string;
      try {
        line = (await rl.question('> ')).trim();
      } catch {
        break;
      }
      if (!line) continue;
      if (line === '/reset') {
        store.reset();
        console.log('(context cleared)');
        continue;
      }
      if (line === '/profile') {
        console.log(JSON.stringify(memory.recall(), null, 2));
        continue;
      }
      try {
        const res = await agent.respond(line);
        console.log(res.text);
      } catch (err) {
        console.error('Agent error:', err instanceof Error ? err.message : err);
      }
    }
  } finally {
    rl.close();
    await mcp.disconnect();
    memory.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
