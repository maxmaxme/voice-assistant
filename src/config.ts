import 'dotenv/config';
import { z } from 'zod';

const ConfigSchema = z.object({
  // Home Assistant connection is no longer an env concern — it's configured via
  // the web panel's integrations and read from the DB at startup (see
  // src/integrations/homeAssistant.ts).
  openai: z.object({
    apiKey: z.string().min(1),
    model: z.string().default('gpt-4o'),
    reasoningEffort: z.enum(['minimal', 'low', 'medium', 'high']).default('low'),
  }),
  memory: z.object({
    dbPath: z.string().default('data/assistant.db'),
  }),
  telegram: z.object({
    botToken: z.string().min(1),
  }),
  realtime: z.object({
    enabled: z.boolean().default(false),
    port: z.coerce.number().int().min(1).max(65535).default(3001),
    token: z.string().default(''),
    model: z.string().default('gpt-realtime-2'),
    voice: z.string().default('marin'),
    reasoningEffort: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh']).default('low'),
    idleResetMs: z.coerce
      .number()
      .int()
      .min(0)
      .default(90 * 1000),
    // Re-clock OpenAI's output audio to the device into fixed frames of this
    // many ms instead of forwarding each delta the instant it arrives. OpenAI
    // bursts a reply far faster than real time (measured ~8× — a 2.9 s reply
    // delivered in ~360 ms); the device's playback chain can't absorb that and
    // hisses. Pacing meters the burst out at ~real time, mirroring what
    // pipecat does. 0 = disabled (forward verbatim, legacy behaviour).
    outputPacingMs: z.coerce.number().int().min(0).max(200).default(20),
  }),
});

export type Config = z.infer<typeof ConfigSchema>;

const PATH_TO_ENV: Record<string, string> = {
  'openai.apiKey': 'OPENAI_API_KEY',
  'openai.model': 'OPENAI_MODEL',
  'openai.reasoningEffort': 'OPENAI_REASONING_EFFORT',
  'memory.dbPath': 'MEMORY_DB_PATH',
  'telegram.botToken': 'TELEGRAM_BOT_TOKEN',
  'realtime.enabled': 'REALTIME_ENABLED',
  'realtime.port': 'REALTIME_PORT',
  'realtime.token': 'VA_DEVICE_TOKEN',
  'realtime.model': 'OPENAI_REALTIME_MODEL',
  'realtime.voice': 'OPENAI_REALTIME_VOICE',
  'realtime.reasoningEffort': 'OPENAI_REALTIME_REASONING_EFFORT',
  'realtime.idleResetMs': 'REALTIME_IDLE_RESET_MS',
  'realtime.outputPacingMs': 'REALTIME_OUTPUT_PACING_MS',
};

/** Read config from `env` (defaults to `process.env`). DB-backed setting
 *  overrides are applied by the caller layering them over `process.env`
 *  before calling — `{ ...process.env, ...overrides }`. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const raw = {
    openai: {
      apiKey: env.OPENAI_API_KEY,
      model: env.OPENAI_MODEL,
      reasoningEffort: env.OPENAI_REASONING_EFFORT,
    },
    memory: {
      dbPath: env.MEMORY_DB_PATH,
    },
    telegram: {
      botToken: env.TELEGRAM_BOT_TOKEN,
    },
    realtime: {
      enabled: env.REALTIME_ENABLED === '1',
      port: env.REALTIME_PORT,
      token: env.VA_DEVICE_TOKEN,
      model: env.OPENAI_REALTIME_MODEL,
      voice: env.OPENAI_REALTIME_VOICE,
      reasoningEffort: env.OPENAI_REALTIME_REASONING_EFFORT,
      idleResetMs: env.REALTIME_IDLE_RESET_MS,
      outputPacingMs: env.REALTIME_OUTPUT_PACING_MS,
    },
  };
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const fields = parsed.error.issues
      .map((i) => {
        const path = i.path.join('.');
        const envName = PATH_TO_ENV[path] ?? path;
        return `${envName} (${path})`;
      })
      .join(', ');
    throw new Error(`Invalid config: ${fields}: ${parsed.error.message}`);
  }
  const data = parsed.data;
  if (data.realtime.enabled && !data.realtime.token) {
    throw new Error('REALTIME_ENABLED=1 but VA_DEVICE_TOKEN is empty');
  }
  return data;
}
