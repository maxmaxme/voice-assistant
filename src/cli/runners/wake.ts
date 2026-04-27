import { spawnSync } from 'node:child_process';
import type OpenAI from 'openai';
import type { OpenAiAgent } from '../../agent/openaiAgent.ts';
import type { Config } from '../../config.ts';
import { NodeSpeakerOutput } from '../../audio/speakerOutput.ts';
import { OpenAiStt } from '../../audio/openaiStt.ts';
import { OpenAiTts } from '../../audio/openaiTts.ts';
import { OpenWakeWord } from '../../audio/wakeWord.ts';
import { Orchestrator } from '../../orchestrator/orchestrator.ts';
import type { Tts } from '../../audio/types.ts';
import { createLogger } from '../../utils/logger.ts';

const log = createLogger('wake');

export interface WakeRunnerDeps {
  agent: OpenAiAgent;
  llm: OpenAI;
  config: Config;
  tts?: Tts;
}

/** Probe ALSA for a capture device. Returns false on Linux when no `card N:`
 * appears in `arecord -l`, or when arecord is missing entirely. On non-Linux
 * platforms (macOS dev) we can't probe via arecord, so assume yes. */
function hasCaptureDevice(): boolean {
  if (process.platform !== 'linux') {
    return true;
  }
  const result = spawnSync('arecord', ['-l'], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    return false;
  }
  return /^card \d+:/m.test(result.stdout);
}

export async function runWakeMode(deps: WakeRunnerDeps): Promise<void> {
  const { agent, llm, config } = deps;

  if (!hasCaptureDevice()) {
    log.warn(
      'no ALSA capture device detected (arecord -l empty); skipping wake-word runner. ' +
        'Plug in a USB mic and restart, or remove `wake` / `both` from AGENT_MODE to silence this warning.',
    );
    // Idle forever so Promise.race in dispatch() doesn't tear down sibling
    // runners (telegram, http) just because we bailed out.
    await new Promise<void>(() => {});
    return;
  }

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
