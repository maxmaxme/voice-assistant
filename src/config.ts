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
    // Only the listen port lives here. The enable switch + pacing + idle are
    // DB-only config (`resolveRealtimeConfig`); devices authenticate per-
    // connection against the `voice` identities, so there is no env token.
    // Model / voice / effort are on the OpenAI integration.
    port: z.coerce.number().int().min(1).max(65535).default(3001),
  }),
});

export type Config = z.infer<typeof ConfigSchema>;

const PATH_TO_ENV: Record<string, string> = {
  'memory.dbPath': 'MEMORY_DB_PATH',
  'realtime.port': 'REALTIME_PORT',
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
