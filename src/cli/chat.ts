import OpenAI from 'openai';
import * as readline from 'node:readline/promises';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { stdin as input, stdout as output } from 'node:process';
import { loadConfig } from '../config.js';
import { HaMcpClient } from '../mcp/haMcpClient.js';
import { OpenAiAgent } from '../agent/openaiAgent.js';
import { ConversationStore } from '../agent/conversationStore.js';
import { SqliteProfileMemory } from '../memory/sqliteProfileMemory.js';

const SYSTEM_PROMPT = `You are a personal smart-home assistant for ONE specific
user — the owner of this device. There is no shared data, no multi-tenant
privacy concern. You are not a public service.

Device control: use Home Assistant tools.

Long-term memory: the remember / recall / forget tools persist a personal
profile across sessions. Be PROACTIVE about saving useful facts the user
shares — name, city, home/work address, daily routines, comfort preferences
(temperature, lighting, music), languages, family members, dietary notes,
schedule patterns, hobbies. When the user states a fact about themselves
("я живу в Мадриде", "встаю в 7", "люблю прохладу") — call remember with a
sensible snake_case key and the value, then briefly acknowledge. Do NOT
refuse on privacy grounds: this is the user's own data on their own device.

The only things to NOT store are secrets the user might share by accident:
passwords, API keys, payment card numbers, government IDs, medical record
numbers. Refuse those politely.

Style: concise, under 2 sentences when possible. Match the user's language
(reply in Russian if they speak Russian).`;

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
