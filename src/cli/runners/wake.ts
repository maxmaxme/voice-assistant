import type OpenAI from 'openai';
import type { OpenAiAgent } from '../../agent/openaiAgent.ts';
import type { Config } from '../../config.ts';
import { NodeSpeakerOutput } from '../../audio/speakerOutput.ts';
import { OpenAiStt } from '../../audio/openaiStt.ts';
import { OpenAiTts } from '../../audio/openaiTts.ts';
import { OpenWakeWord } from '../../audio/wakeWord.ts';
import { Orchestrator } from '../../orchestrator/orchestrator.ts';
import type { Tts } from '../../audio/types.ts';

export interface WakeRunnerDeps {
  agent: OpenAiAgent;
  llm: OpenAI;
  config: Config;
  tts?: Tts;
}

export async function runWakeMode(deps: WakeRunnerDeps): Promise<void> {
  const { agent, llm, config } = deps;

  const wake = new OpenWakeWord({
    pythonPath: config.wakeWord.pythonPath,
    scriptPath: config.wakeWord.scriptPath,
    keyword: config.wakeWord.keyword,
    threshold: config.wakeWord.threshold,
    debug: config.wakeWord.debug,
  });

  const orch = new Orchestrator({
    agent,
    stt: new OpenAiStt({ client: llm }),
    tts: deps.tts ?? new OpenAiTts({ client: llm }),
    speaker: new NodeSpeakerOutput(),
    wake,
    sampleRate: wake.sampleRate,
    followUp: config.wakeWord.followUp,
  });

  // SIGINT handling moved to unified.ts so it can dispose all runners' resources.
  await orch.run(); // never resolves
}
