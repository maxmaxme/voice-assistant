import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import type { OpenAiAgent } from '../../agent/openaiAgent.ts';
import { NodeMicInput } from '../../audio/micInput.ts';
import { NodeSpeakerOutput } from '../../audio/speakerOutput.ts';
import type { Stt, Tts } from '../../audio/types.ts';

const MIC_SAMPLE_RATE = 16000;

export interface VoiceRunnerDeps {
  agent: OpenAiAgent;
  stt: Stt;
  tts: Tts;
}

export async function runVoiceMode(deps: VoiceRunnerDeps): Promise<void> {
  const { agent, stt, tts } = deps;
  const mic = new NodeMicInput();
  const speaker = new NodeSpeakerOutput();
  const rl = readline.createInterface({ input, output });
  console.log(
    'Voice push-to-talk. Press Enter to start recording, Enter again to stop. Ctrl+C to quit.',
  );

  try {
    while (true) {
      await rl.question('Press Enter to talk... ');
      const recording = await mic.record({ sampleRate: MIC_SAMPLE_RATE });
      console.log('Listening. Press Enter when done.');
      await rl.question('');
      const audio = await recording.stop();
      console.log(`Captured ${audio.length} bytes; transcribing...`);

      const text = (await stt.transcribe(audio, { sampleRate: MIC_SAMPLE_RATE })).trim();
      if (!text) {
        console.log('(no speech detected)');
        continue;
      }
      console.log(`User: ${text}`);

      const reply = await agent.respond(text);
      console.log(`Assistant: ${reply.text}`);

      const stream = tts.stream(reply.text);
      await speaker.playStream(stream);
    }
  } finally {
    rl.close();
  }
}
