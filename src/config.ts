import 'dotenv/config';
import { z } from 'zod';

const ConfigSchema = z.object({
  // Home Assistant, OpenAI AND Telegram connections are no longer env concerns —
  // they're configured via the web panel's integrations and read from the DB at
  // startup (see src/integrations/). Only process-level + universal realtime
  // knobs here.
  memory: z.object({
    dbPath: z.string().default('data/assistant.db'),
  }),
  realtime: z.object({
    // enabled / model / voice / reasoningEffort come from the OpenAI integration.
    // port + device token stay env (infra/secret); pacing + idle stay Settings.
    port: z.coerce.number().int().min(1).max(65535).default(3001),
    token: z.string().default(''),
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
  'memory.dbPath': 'MEMORY_DB_PATH',
  'realtime.port': 'REALTIME_PORT',
  'realtime.token': 'VA_DEVICE_TOKEN',
  'realtime.idleResetMs': 'REALTIME_IDLE_RESET_MS',
  'realtime.outputPacingMs': 'REALTIME_OUTPUT_PACING_MS',
};

/** Read config from `env` (defaults to `process.env`). DB-backed setting
 *  overrides are applied by the caller layering them over `process.env`
 *  before calling — `{ ...process.env, ...overrides }`. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const raw = {
    memory: {
      dbPath: env.MEMORY_DB_PATH,
    },
    realtime: {
      port: env.REALTIME_PORT,
      token: env.VA_DEVICE_TOKEN,
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
  return parsed.data;
}
