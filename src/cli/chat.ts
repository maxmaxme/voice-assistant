import OpenAI from 'openai';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { loadConfig } from '../config.js';
import { HaMcpClient } from '../mcp/haMcpClient.js';
import { OpenAiAgent } from '../agent/openaiAgent.js';
import { ConversationStore } from '../agent/conversationStore.js';

const SYSTEM_PROMPT = `You are a smart-home voice assistant for the user's home.
You control devices through Home Assistant tools available to you.
Be concise: under 2 sentences when possible. Speak Russian if the user does.
If a tool fails, explain briefly. Do not invent device names — list tools first if unsure.`;

async function main(): Promise<void> {
  const cfg = loadConfig();
  const llm = new OpenAI({ apiKey: cfg.openai.apiKey });
  const mcp = new HaMcpClient({ url: cfg.ha.url, token: cfg.ha.token });
  await mcp.connect();
  const store = new ConversationStore({ idleTimeoutMs: 3 * 60 * 1000, maxMessages: 20 });
  const agent = new OpenAiAgent({
    mcp,
    store,
    systemPrompt: SYSTEM_PROMPT,
    model: cfg.openai.model,
    llmClient: llm,
  });

  const rl = readline.createInterface({ input, output });
  console.log('Chat ready. Type your command. Ctrl+C to exit. /reset to clear context.');

  try {
    while (true) {
      const line = (await rl.question('> ')).trim();
      if (!line) continue;
      if (line === '/reset') {
        store.reset();
        console.log('(context cleared)');
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
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
