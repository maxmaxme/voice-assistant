import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import type { OpenAiAgent } from '../../agent/openaiAgent.ts';
import type { Session } from '../../agent/session.ts';
import type { MemoryStore } from '../../memory/types.ts';

export interface ChatRunnerDeps {
  agent: OpenAiAgent;
  session: Session;
  memory: MemoryStore;
}

export async function runChatMode(deps: ChatRunnerDeps): Promise<void> {
  const { agent, session, memory } = deps;
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
      if (!line) {
        continue;
      }
      if (line === '/reset') {
        session.reset();
        console.log('(context cleared)');
        continue;
      }
      if (line === '/profile') {
        console.log(JSON.stringify(memory.profile.recall(), null, 2));
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
  }
}
