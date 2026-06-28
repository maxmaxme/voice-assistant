import 'dotenv/config';
import { z } from 'zod';

const ConfigSchema = z.object({
  memory: z.object({
    dbPath: z.string().default('data/assistant.db'),
  }),
  http: z.object({
    port: z.coerce.number().int().min(1).max(65535).default(3000),
  }),
  realtime: z.object({
    port: z.coerce.number().int().min(1).max(65535).default(3001),
  }),
});

export type Config = z.infer<typeof ConfigSchema>;

const PATH_TO_ENV: Record<string, string> = {
  'memory.dbPath': 'MEMORY_DB_PATH',
  'http.port': 'HTTP_SERVER_PORT',
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
    http: {
      port: env.HTTP_SERVER_PORT,
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
