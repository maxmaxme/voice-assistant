import 'dotenv/config';
import { z } from 'zod';

const ConfigSchema = z.object({
  ha: z.object({
    url: z.string().url(),
    token: z.string().min(1),
  }),
  openai: z.object({
    apiKey: z.string().min(1),
    model: z.string().default('gpt-4o'),
  }),
  memory: z.object({
    dbPath: z.string().default('data/assistant.db'),
  }),
});

export type Config = z.infer<typeof ConfigSchema>;

const PATH_TO_ENV: Record<string, string> = {
  'ha.url': 'HA_URL',
  'ha.token': 'HA_TOKEN',
  'openai.apiKey': 'OPENAI_API_KEY',
  'openai.model': 'OPENAI_MODEL',
  'memory.dbPath': 'MEMORY_DB_PATH',
};

export function loadConfig(): Config {
  const raw = {
    ha: {
      url: process.env.HA_URL,
      token: process.env.HA_TOKEN,
    },
    openai: {
      apiKey: process.env.OPENAI_API_KEY,
      model: process.env.OPENAI_MODEL,
    },
    memory: {
      dbPath: process.env.MEMORY_DB_PATH,
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
