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
import { NodeMicInput } from '../audio/micInput.js';
import { NodeSpeakerOutput } from '../audio/speakerOutput.js';
import { OpenAiStt } from '../audio/openaiStt.js';
import { OpenAiTts } from '../audio/openaiTts.js';

const SYSTEM_PROMPT = `You are a smart-home voice assistant.
You control devices through Home Assistant tools.
Long-term user profile is available via remember/recall/forget.
Be concise (1-2 sentences). Speak Russian if the user does.`;

const MIC_SAMPLE_RATE = 16000;

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

  const mic = new NodeMicInput();
  const speaker = new NodeSpeakerOutput();
  const stt = new OpenAiStt({ client: llm });
  const tts = new OpenAiTts({ client: llm });

  const rl = readline.createInterface({ input, output });
  console.log('Voice push-to-talk. Press Enter to start recording, Enter again to stop. Ctrl+C to quit.');

  try {
    while (true) {
      await rl.question('Press Enter to talk... ');
      const session = await mic.record({ sampleRate: MIC_SAMPLE_RATE });
      console.log('Listening. Press Enter when done.');
      await rl.question('');
      const audio = await session.stop();
      console.log(`Captured ${audio.length} bytes; transcribing...`);

      const text = (await stt.transcribe(audio, { sampleRate: MIC_SAMPLE_RATE, language: 'ru' })).trim();
      if (!text) {
        console.log('(no speech detected)');
        continue;
      }
      console.log(`User: ${text}`);

      const reply = await agent.respond(text);
      console.log(`Assistant: ${reply.text}`);

      const { audio: ttsAudio, sampleRate } = await tts.synthesize(reply.text);
      await speaker.play(ttsAudio, { sampleRate });
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
